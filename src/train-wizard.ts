import { mkdir, unlink } from "node:fs/promises";
import * as p from "@clack/prompts";
import { createCommandRunner } from "./command.js";
import {
  loadRepos,
  writeTrainYaml,
  type PackConfig,
  type ReposConfig,
  type TrainConfig,
  type TrainStep
} from "./config.js";
import { GitLab } from "./gitlab.js";
import { CONFIG_DIR, REPOS_FILE, pathExists, slugify, trainDir } from "./paths.js";
import {
  ensureUniqueTrainId,
  getTrainContext,
  listActiveTrains,
  type TrainSummary
} from "./train-registry.js";
import { runRevokeApprovalWizard } from "./revoke-approval-wizard.js";
import { runWorkflow } from "./workflow.js";
import { WorkspaceManager } from "./workspace.js";

export async function handleDefaultCommand(): Promise<void> {
  if (!(await pathExists(REPOS_FILE))) {
    p.log.error("No config found. Run: gitlab-mr-train init");
    process.exitCode = 1;
    return;
  }

  const activeTrains = await listActiveTrains();
  const picked = await pickLauncherOption(activeTrains);
  if (picked === null) return;

  if (picked === "__revoke__") {
    await runRevokeApprovalWizard();
    return;
  }
  if (picked === "__new__") {
    await startNewTrain();
    return;
  }

  await handleTrainAction(picked);
}

export async function pickTrainSlug(provided?: string): Promise<string | undefined> {
  if (provided) return provided;

  const activeTrains = await listActiveTrains();
  if (activeTrains.length === 0) {
    p.log.error("No active trains. Start one with: gitlab-mr-train");
    return undefined;
  }
  if (activeTrains.length === 1) return activeTrains[0]!.trainId;

  const picked = await p.select({
    message: "Which train?",
    options: activeTrains.map((train) => ({
      value: train.trainId,
      label: `${train.name} (${train.summary})`
    }))
  });
  if (p.isCancel(picked)) return undefined;
  return String(picked);
}

export async function abortTrain(trainId: string, execute = true): Promise<void> {
  const ctx = getTrainContext(trainId);
  const runner = createCommandRunner(execute);
  const workspace = new WorkspaceManager(trainId, runner);

  if (await pathExists(ctx.stateFile)) {
    await unlink(ctx.stateFile);
    console.log(`Cleared ${ctx.stateFile}`);
  } else {
    console.log(`No state for train "${trainId}".`);
  }

  await workspace.cleanup();
}

async function pickLauncherOption(activeTrains: TrainSummary[]): Promise<string | null> {
  p.intro("gitlab-mr-train");

  const choice = await p.select({
    message: activeTrains.length > 0 ? "Active trains" : "What would you like to do?",
    options: [
      ...activeTrains.map((train) => ({
        value: train.trainId,
        label: `${train.name} (${train.summary})`
      })),
      { value: "__new__", label: "Start new train" },
      { value: "__revoke__", label: "Revoke MR approval" }
    ]
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    return null;
  }

  return String(choice);
}

async function handleTrainAction(trainId: string): Promise<void> {
  const ctx = getTrainContext(trainId);
  const { readState } = await import("./state.js");
  const { loadTrain } = await import("./config.js");
  const state = await readState(ctx.stateFile);

  let trainName = trainId;
  try {
    const train = await loadTrain(ctx.trainFile);
    trainName = train.name;
  } catch {
    // ponytail: fall back to trainId
  }

  p.intro(`gitlab-mr-train — ${trainName}`);

  console.log();
  for (const [id, step] of Object.entries(state.steps)) {
    const icon = step.status === "done" ? "✓" : step.status === "failed" ? "✗" : "·";
    const detail = step.error ? ` — ${step.error}` : ` — ${step.status}`;
    console.log(`  ${icon} ${id}${detail}`);
  }
  console.log();

  const choice = await p.select({
    message: "What next?",
    options: [
      { value: "resume", label: "Resume" },
      { value: "abort", label: "Abort (clear state + workspace)" },
      { value: "new", label: "Start new train" }
    ]
  });

  if (p.isCancel(choice)) {
    p.cancel("Cancelled.");
    return;
  }

  if (choice === "abort") {
    await abortTrain(trainId);
    p.outro("Train aborted.");
    return;
  }

  if (choice === "new") {
    await startNewTrain();
    return;
  }

  const execute = await confirmExecute();
  if (execute === null) return;

  await runWorkflow({
    trainId,
    trainFile: ctx.trainFile,
    stateFile: ctx.stateFile,
    execute,
    resume: true
  });
}

async function startNewTrain(): Promise<void> {
  p.intro("gitlab-mr-train — new train");

  const result = await runTrainWizard();
  if (!result) return;

  const { train, trainId } = result;
  const ctx = getTrainContext(trainId);
  await mkdir(trainDir(trainId), { recursive: true });
  await writeTrainYaml(ctx.trainFile, train);

  const execute = await confirmExecute();
  if (execute === null) return;

  await runWorkflow({
    trainId,
    trainFile: ctx.trainFile,
    stateFile: ctx.stateFile,
    execute,
    resume: false
  });
}

async function confirmExecute(): Promise<boolean | null> {
  const execute = await p.confirm({
    message: "Execute for real? (No = dry-run)",
    initialValue: true
  });
  if (p.isCancel(execute)) {
    p.cancel("Cancelled.");
    return null;
  }
  return execute;
}

async function runTrainWizard(): Promise<{ train: TrainConfig; trainId: string } | undefined> {
  const repos = await loadRepos(REPOS_FILE);
  const repoIds = Object.keys(repos.repos);
  if (repoIds.length === 0) {
    p.log.error("repos.yaml has no repos. Run: gitlab-mr-train init");
    return undefined;
  }

  const defaultName = "my-train";
  const nameRaw = await p.text({
    message: "Train name",
    initialValue: defaultName,
    validate: (value) => (value?.trim() ? undefined : "Required")
  });
  if (p.isCancel(nameRaw)) {
    p.cancel("Cancelled.");
    return undefined;
  }

  const trainId = await ensureUniqueTrainId(slugify(String(nameRaw)));

  const gitlab = new GitLab(createCommandRunner(true));
  const steps: TrainStep[] = [];

  const pollRaw = await p.text({
    message: "Poll interval (seconds)",
    initialValue: "60",
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) return "Enter a positive integer";
      return undefined;
    }
  });
  if (p.isCancel(pollRaw)) {
    p.cancel("Cancelled.");
    return undefined;
  }
  const pollSeconds = Number(pollRaw);

  while (true) {
    const step = await promptStep(repos, steps, gitlab);
    if (!step) return undefined;
    steps.push(step);

    const again = await p.confirm({ message: "Add another step?", initialValue: false });
    if (p.isCancel(again) || !again) break;
  }

  if (steps.length === 0) {
    p.cancel("No steps configured.");
    return undefined;
  }

  const train: TrainConfig = {
    name: String(nameRaw).trim(),
    reposFile: "../../repos.yaml",
    pollSeconds,
    steps
  };

  console.log("\nSummary:");
  for (const step of steps) {
    const packLabel =
      step.pack === "none"
        ? "none"
        : typeof step.pack === "string"
          ? step.pack
          : step.pack.job ?? "gitlabJob";
    console.log(
      `  ${step.id}: repo=${step.repo} mr=${step.mr ?? "-"} pack=${packLabel} dependsOn=[${step.dependsOn.join(", ")}]`
    );
  }
  console.log(`\nTrain id: ${trainId}`);
  console.log(`Config dir: ${CONFIG_DIR}\n`);

  const confirmed = await p.confirm({ message: "Save and run this train?", initialValue: true });
  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Cancelled.");
    return undefined;
  }

  return { train, trainId };
}

async function promptStep(
  repos: ReposConfig,
  priorSteps: TrainStep[],
  gitlab: GitLab
): Promise<TrainStep | undefined> {
  const repoId = await p.select({
    message: "Repo",
    options: Object.entries(repos.repos).map(([id, repo]) => ({
      value: id,
      label: `${id}${repo.name ? ` (${repo.name})` : ""}`
    }))
  });
  if (p.isCancel(repoId)) {
    p.cancel("Cancelled.");
    return undefined;
  }

  const mrRaw = await p.text({
    message: "MR number (leave empty to skip merge)",
    initialValue: ""
  });
  if (p.isCancel(mrRaw)) {
    p.cancel("Cancelled.");
    return undefined;
  }

  const pack = await promptPack(repos.repos[String(repoId)], gitlab);

  let dependsOn: string[] = [];
  if (priorSteps.length > 0) {
    const deps = await p.multiselect({
      message: "Depends on (prior steps)",
      options: priorSteps.map((step) => ({ value: step.id, label: step.id })),
      required: false
    });
    if (p.isCancel(deps)) {
      p.cancel("Cancelled.");
      return undefined;
    }
    dependsOn = deps as string[];
  }

  const librarySteps = priorSteps.filter((step) => repos.repos[step.repo]?.packageName);
  let updatePackages: TrainStep["updatePackages"] = [];
  if (librarySteps.length > 0) {
    const updates = await p.multiselect({
      message: "Update packages from (prior library steps)",
      options: librarySteps.map((step) => ({
        value: step.id,
        label: `${step.id} (${repos.repos[step.repo]?.packageName})`
      })),
      required: false
    });
    if (p.isCancel(updates)) {
      p.cancel("Cancelled.");
      return undefined;
    }
    updatePackages = (updates as string[]).map((from) => ({ from }));
  }

  const step: TrainStep = {
    id: String(repoId),
    repo: String(repoId),
    dependsOn,
    updatePackages,
    pack
  };

  const mr = String(mrRaw).trim();
  if (mr) {
    step.mr = /^\d+$/.test(mr) ? Number(mr) : mr;
  }

  return step;
}

async function promptPack(repo: ReposConfig["repos"][string], gitlab: GitLab): Promise<PackConfig> {
  p.log.step(`Fetching manual CI jobs for ${repo.name ?? repo.gitlab}…`);

  let jobs: string[] = [];
  try {
    jobs = await gitlab.listManualJobs(repo);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.warn(`Could not fetch jobs: ${message}`);
  }

  const options = [{ value: "none", label: "none (skip pack)" }];
  for (const job of jobs) {
    options.push({ value: job, label: job });
  }
  options.push({ value: "__custom__", label: "Custom job name…" });

  const selected = await p.select({
    message: "Pack job",
    options
  });
  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  if (selected === "none") return "none";
  if (selected === "__custom__") {
    const custom = await p.text({
      message: "GitLab job name",
      validate: (value) => (value?.trim() ? undefined : "Required")
    });
    if (p.isCancel(custom)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    return { type: "gitlabJob", job: String(custom).trim() };
  }

  return { type: "gitlabJob", job: String(selected) };
}
