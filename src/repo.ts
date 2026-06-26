import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "./command.js";
import type { RepoConfig } from "./config.js";

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

export async function readPackageVersion(repo: RepoConfig): Promise<string | undefined> {
  const pkg = await readPackageJson(join(repo.path, repo.versionPackageJson));
  return pkg.version;
}

export function formatDependencyVersion(
  section: "dependencies" | "devDependencies" | "peerDependencies",
  version: string,
  existing?: string
): string {
  if (section === "peerDependencies") {
    if (existing?.includes("|| 0.0.x")) return `>=${version} || 0.0.x`;
    if (existing?.startsWith(">=")) {
      const suffix = existing.replace(/^>=[\d.]+(?:-[\w.]+)?/, "");
      return `>=${version}${suffix}`;
    }
    return `>=${version} || 0.0.x`;
  }

  return version;
}

export async function updateDependency(repo: RepoConfig, packageName: string, version: string): Promise<boolean> {
  let changed = false;

  for (const relativePackagePath of repo.dependencyPackageJsons) {
    const packagePath = join(repo.path, relativePackagePath);
    const raw = await readFile(packagePath, "utf8");
    const pkg = JSON.parse(raw) as PackageJson;
    let fileChanged = false;

    for (const section of ["dependencies", "devDependencies", "peerDependencies"] as const) {
      const current = pkg[section]?.[packageName];
      if (!current) continue;

      const next = formatDependencyVersion(section, version, current);
      if (current !== next) {
        pkg[section]![packageName] = next;
        fileChanged = true;
        changed = true;
      }
    }

    if (fileChanged) {
      await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
  }

  return changed;
}

export async function pullMainBranch(runner: CommandRunner, repo: RepoConfig): Promise<void> {
  await runner.run("git", ["checkout", repo.mainBranch], { cwd: repo.path });
  await runner.run("git", ["pull", "origin", repo.mainBranch], { cwd: repo.path });
}

export async function installCommitPush(
  runner: CommandRunner,
  repo: RepoConfig,
  message: string
): Promise<void> {
  const filesToAdd = [...new Set(["package.json", "package-lock.json", ...repo.dependencyPackageJsons])];
  await runner.run("npm", ["install"], { cwd: repo.path });
  await runner.run("git", ["add", ...filesToAdd], { cwd: repo.path });
  await runner.run("git", ["commit", "-m", message], { cwd: repo.path });
  await runner.run("git", ["push"], { cwd: repo.path });
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return JSON.parse(await readFile(path, "utf8")) as PackageJson;
}
