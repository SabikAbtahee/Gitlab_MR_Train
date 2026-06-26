import { dirname, resolve } from "node:path";
import { createCommandRunner } from "./command.js";
import { loadRepos, loadTrain, topoSortSteps, type ReposConfig, type TrainConfig, type TrainStep } from "./config.js";
import { GitLab } from "./gitlab.js";
import { installCommitPush, pullMainBranch, readPackageVersion, updateDependency } from "./repo.js";
import { newRunState, readState, setStep, writeState, type RunState, type StepStatus } from "./state.js";
import { WorkspaceManager } from "./workspace.js";

export type RunOptions = {
  trainId: string;
  trainFile: string;
  stateFile: string;
  execute: boolean;
  resume: boolean;
};

export async function runWorkflow(options: RunOptions): Promise<void> {
  const trainPath = resolve(options.trainFile);
  const train = await loadTrain(trainPath);
  const reposPath = resolve(dirname(trainPath), train.reposFile);
  const repos = await loadRepos(reposPath);
  const orderedSteps = topoSortSteps(train.steps);
  const state = options.resume
    ? await readState(options.stateFile)
    : newRunState(options.trainId, trainPath, options.execute, orderedSteps.map((step) => step.id));

  const runner = createCommandRunner(options.execute);
  const gitlab = new GitLab(runner);
  const workspace = new WorkspaceManager(options.trainId, runner);

  console.log(`${options.execute ? "Executing" : "Dry-run"} train "${train.name}" (${options.trainId})`);
  console.log(`State: ${options.stateFile}`);

  try {
    for (const step of orderedSteps) {
      if (state.steps[step.id]?.status === "done") {
        console.log(`✓ ${step.id} already done`);
        continue;
      }

      try {
        await runStep(step, train, repos, state, gitlab, runner, workspace, options.stateFile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setStep(state, step.id, "failed", { error: message });
        await writeState(options.stateFile, state);
        throw error;
      }
    }

    console.log("Release train complete.");
    await workspace.cleanup();
  } catch (error) {
    if (options.execute) {
      const { workspaceDir } = await import("./paths.js");
      console.log(`Workspace kept for resume: ${workspaceDir(options.trainId)}`);
    }
    throw error;
  }
}

async function runStep(
  step: TrainStep,
  train: TrainConfig,
  repos: ReposConfig,
  state: RunState,
  gitlab: GitLab,
  runner: ReturnType<typeof createCommandRunner>,
  workspace: WorkspaceManager,
  stateFile: string
): Promise<void> {
  const repo = repos.repos[step.repo];
  if (!repo) throw new Error(`Step "${step.id}" references unknown repo "${step.repo}"`);

  const previousStatus = state.steps[step.id]?.status ?? "pending";
  console.log(`\n== ${step.id} (${repo.name ?? step.repo}) ==`);

  if (step.mr && !hasPassedMerge(previousStatus)) {
    const merged = await gitlab.isMrMerged(repo, step.mr);
    if (merged) {
      console.log(`MR ${step.mr} already merged; skipping merge`);
    } else {
      setStep(state, step.id, "waiting_mr_ready");
      await writeState(stateFile, state);
      await waitForMrReady(gitlab, repo, step.mr, train.pollSeconds);
      setStep(state, step.id, "merging");
      await writeState(stateFile, state);
      await gitlab.merge(repo, step.mr);
    }
  } else if (!step.mr) {
    console.log("No MR configured; skipping merge.");
  } else {
    console.log(`MR ${step.mr} merge phase already done; continuing`);
  }

  let pipeline;
  const savedPipelineId = state.steps[step.id]?.pipelineId;

  if (hasPassedPipeline(previousStatus) && savedPipelineId) {
    console.log(`Using saved merge pipeline ${savedPipelineId}`);
    pipeline = await gitlab.getPipeline(repo, savedPipelineId);
  } else if (hasPassedPipeline(previousStatus)) {
    console.log("Pipeline wait already done; fetching current pipeline");
    pipeline = (await gitlab.getBranchPipeline(repo)) ?? (await gitlab.waitForBranchPipeline(repo, train.pollSeconds));
  } else {
    setStep(state, step.id, "waiting_main_pipeline");
    await writeState(stateFile, state);
    pipeline = await gitlab.waitForBranchPipeline(repo, train.pollSeconds);
  }

  if (pipeline.id) {
    setStep(state, step.id, state.steps[step.id]?.status ?? "waiting_main_pipeline", { pipelineId: pipeline.id });
    await writeState(stateFile, state);
  }

  if (step.pack !== "none") {
    if (!pipeline?.id) throw new Error(`No pipeline id available for pack step "${step.id}"`);
    setStep(state, step.id, "packing", { pipelineId: pipeline.id });
    await writeState(stateFile, state);
    await gitlab.ensurePackComplete(repo, step.pack, pipeline.id, train.pollSeconds);
    const mainPath = await workspace.checkoutMain(step.repo, repo);
    await pullMainBranch(runner, workspace.withPath(repo, mainPath));
  }

  let version: string | undefined;
  if (repo.packageName) {
    const mainPath = await workspace.checkoutMain(step.repo, repo);
    version = await readPackageVersion(workspace.withPath(repo, mainPath));
  }
  if (version) {
    state.versions[step.id] = version;
    console.log(`${repo.packageName} version: ${version}`);
  }

  setStep(state, step.id, "updating_dependents", { version });
  await writeState(stateFile, state);
  await updateDependentPackages(step, train.steps, repos, state, gitlab, runner, workspace);

  setStep(state, step.id, "done", { version });
  await writeState(stateFile, state);
}

async function waitForMrReady(
  gitlab: GitLab,
  repo: ReposConfig["repos"][string],
  mr: string | number,
  pollSeconds: number
): Promise<void> {
  while (true) {
    const readiness = await gitlab.mrReadiness(repo, mr);
    if (readiness.ready) return;

    console.log(`MR ${mr} not ready: ${readiness.reasons.join("; ")}`);
    await sleep(pollSeconds * 1000);
  }
}

async function updateDependentPackages(
  completedStep: TrainStep,
  allSteps: TrainStep[],
  repos: ReposConfig,
  state: RunState,
  gitlab: GitLab,
  runner: ReturnType<typeof createCommandRunner>,
  workspace: WorkspaceManager
): Promise<void> {
  const version = state.versions[completedStep.id];
  const sourceRepo = repos.repos[completedStep.repo];
  if (!version || !sourceRepo?.packageName) return;

  for (const step of allSteps) {
    const update = step.updatePackages.find((candidate) => candidate.from === completedStep.id);
    if (!update) continue;

    const targetRepo = repos.repos[step.repo];
    if (!targetRepo) throw new Error(`Step "${step.id}" references unknown repo "${step.repo}"`);

    const packageName = update.packageName ?? sourceRepo.packageName;
    let targetPath: string;

    if (step.mr) {
      const branch = await gitlab.getMrBranch(targetRepo, step.mr);
      targetPath = await workspace.checkoutBranch(step.repo, targetRepo, branch);
    } else {
      console.log(`${step.id}: no MR configured; updating on ${targetRepo.mainBranch}`);
      targetPath = await workspace.checkoutMain(step.repo, targetRepo);
    }

    const workingRepo = workspace.withPath(targetRepo, targetPath);

    if (!runner.execute) {
      console.log(
        `[dry-run] update ${targetPath} manifests (${workingRepo.dependencyPackageJsons.join(", ")}): ${packageName} -> ${version}`
      );
      continue;
    }

    const changed = await updateDependency(workingRepo, packageName, version);
    if (!changed) {
      console.log(`${step.id}: ${packageName} not found or already ${version}`);
      continue;
    }

    await installCommitPush(runner, workingRepo, `chore: update ${packageName} to ${version}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasPassedMerge(status: StepStatus): boolean {
  return ["waiting_main_pipeline", "packing", "updating_dependents", "done"].includes(status);
}

function hasPassedPipeline(status: StepStatus): boolean {
  return ["packing", "updating_dependents", "done"].includes(status);
}
