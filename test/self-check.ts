import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { downstreamStepIds, packJobName, topoSortSteps, type TrainStep } from "../src/config.js";
import { rulesToRevoke, type ApprovalRule } from "../src/gitlab.js";
import { slugify } from "../src/paths.js";
import { updateDependency } from "../src/repo.js";
import { isTrainActive } from "../src/train-registry.js";
import { newRunState } from "../src/state.js";

const steps: TrainStep[] = [
  { id: "appA", repo: "appA", dependsOn: ["libB"], updatePackages: [], pack: "none" },
  { id: "libA", repo: "libA", dependsOn: [], updatePackages: [], pack: "minor" },
  { id: "libB", repo: "libB", dependsOn: ["libA"], updatePackages: [], pack: "patch" }
];

assert.deepEqual(
  topoSortSteps(steps).map((step) => step.id),
  ["libA", "libB", "appA"]
);

assert.equal(packJobName("minor"), "pack Minor");
assert.equal(packJobName("none"), undefined);
assert.equal(packJobName({ type: "gitlabJob", job: "release:minor" }), "release:minor");

assert.deepEqual(downstreamStepIds(steps, "libA"), ["libB", "appA"]);
assert.deepEqual(downstreamStepIds(steps, "libB"), ["appA"]);
assert.deepEqual(downstreamStepIds(steps, "appA"), []);

assert.equal(slugify("Dashboard Filters"), "dashboard-filters");
assert.equal(slugify("  My Train!!  "), "my-train");

const runState = newRunState("my-train", "/tmp/train.yaml", true, ["a", "b"]);
assert.equal(isTrainActive(runState), true);
runState.steps.a!.status = "done";
runState.steps.b!.status = "done";
assert.equal(isTrainActive(runState), false);

const approvalRules: ApprovalRule[] = [
  { id: 1, name: "QA", approvals_required: 2 },
  { id: 2, name: "Security", approvals_required: 1 },
  { id: 3, name: "Lead", approvals_required: 2 }
];
assert.deepEqual(rulesToRevoke(approvalRules).map((rule) => rule.id), [1, 3]);
assert.deepEqual(rulesToRevoke([]), []);
assert.deepEqual(rulesToRevoke([{ id: 4, approvals_required: 0 }]), []);

const dir = await mkdtemp(join(tmpdir(), "gitlab-release-train-"));
try {
  const packagePath = join(dir, "package.json");
  await writeFile(
    packagePath,
    JSON.stringify(
      {
        dependencies: {
          "@acme/lib-a": "1.2.0"
        }
      },
      null,
      2
    )
  );

  const changed = await updateDependency(
    {
      path: dir,
      gitlab: "unused",
      mainBranch: "main",
      packageJson: "package.json",
      versionPackageJson: "package.json",
      dependencyPackageJsons: ["package.json"]
    },
    "@acme/lib-a",
    "1.3.0"
  );

  assert.equal(changed, true);
  const updated = JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies: Record<string, string>;
  };
  assert.equal(updated.dependencies["@acme/lib-a"], "1.3.0");

  const libPackagePath = join(dir, "lib", "package.json");
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(
    libPackagePath,
    JSON.stringify(
      {
        peerDependencies: {
          "@acme/lib-a": ">=1.0.0 || 0.0.x"
        }
      },
      null,
      2
    )
  );

  const peerChanged = await updateDependency(
    {
      path: dir,
      gitlab: "unused",
      mainBranch: "main",
      packageJson: "package.json",
      versionPackageJson: "package.json",
      dependencyPackageJsons: ["package.json", "lib/package.json"]
    },
    "@acme/lib-a",
    "1.3.0"
  );

  assert.equal(peerChanged, true);
  const libUpdated = JSON.parse(await readFile(libPackagePath, "utf8")) as {
    peerDependencies: Record<string, string>;
  };
  assert.equal(libUpdated.peerDependencies["@acme/lib-a"], ">=1.3.0 || 0.0.x");
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log("self-check passed");
