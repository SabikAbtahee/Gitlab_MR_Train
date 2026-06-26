#!/usr/bin/env node
import { resolve } from "node:path";
import { downstreamStepIds, loadTrain } from "./config.js";
import { runInitWizard } from "./init-wizard.js";
import { slugify } from "./paths.js";
import { getTrainContext } from "./train-registry.js";
import { readState, resetStepForRerun, writeState } from "./state.js";
import { abortTrain, handleDefaultCommand, pickTrainSlug } from "./train-wizard.js";
import { runWorkflow } from "./workflow.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === "train") {
    await handleDefaultCommand();
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "init") {
    await runInitWizard({
      add: args.includes("--add"),
      edit: valueAfter(args, "--edit")
    });
    return;
  }

  if (command === "abort") {
    const trainId = await resolveTrainId(args);
    if (!trainId) return;
    await abortTrain(trainId);
    return;
  }

  if (command === "run") {
    const trainFile = positionalArg(args, ["--execute", "--train", "--state"]);
    if (!trainFile) throw new Error("Missing train file: gitlab-mr-train run <train.yaml>");

    const trainPath = resolve(trainFile);
    const train = await loadTrain(trainPath);
    const trainId = valueAfter(args, "--train") ?? slugify(train.name);
    const ctx = getTrainContext(trainId);

    await runWorkflow({
      trainId,
      trainFile: trainPath,
      stateFile: valueAfter(args, "--state") ?? ctx.stateFile,
      execute: args.includes("--execute"),
      resume: false
    });
    return;
  }

  if (command === "resume") {
    const trainId = await resolveTrainId(args);
    if (!trainId) return;

    const ctx = getTrainContext(trainId);
    const state = await readState(ctx.stateFile);
    await runWorkflow({
      trainId,
      trainFile: state.trainFile,
      stateFile: ctx.stateFile,
      execute: args.includes("--execute") || state.execute,
      resume: true
    });
    return;
  }

  if (command === "reset") {
    const stepId = positionalArg(args, ["--execute", "--train", "--state"]);
    if (!stepId) throw new Error("Missing step id: gitlab-mr-train reset <step-id>");

    const trainId = await resolveTrainId(args);
    if (!trainId) return;

    const ctx = getTrainContext(trainId);
    const state = await readState(ctx.stateFile);
    const train = await loadTrain(resolve(state.trainFile));
    const downstream = downstreamStepIds(train.steps, stepId);
    resetStepForRerun(state, stepId, downstream);
    await writeState(ctx.stateFile, state);
    console.log(`Reset step "${stepId}" to waiting_main_pipeline (pipelineId kept)`);
    if (downstream.length > 0) {
      console.log(`Reset downstream steps: ${downstream.join(", ")}`);
    }
    console.log(`Resume with: gitlab-mr-train resume --train ${trainId} --execute`);
    return;
  }

  throw new Error(`Unknown command "${command}"`);
}

async function resolveTrainId(args: string[]): Promise<string | undefined> {
  const provided = valueAfter(args, "--train");
  if (provided) return provided;
  return pickTrainSlug();
}

function positionalArg(args: string[], flags: string[]): string | undefined {
  return args.find((arg) => !flags.includes(arg) && !arg.startsWith("--"));
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`gitlab-mr-train — GitLab MR release train runner

Usage:
  gitlab-mr-train                        Interactive picker / new train / revoke MR approval
  gitlab-mr-train init                     Set up ~/.config/gitlab-mr-train/repos.yaml
  gitlab-mr-train init --add               Add repos to existing config
  gitlab-mr-train init --edit <id>         Update one repo
  gitlab-mr-train abort [--train <slug>]   Clear train state + workspace
  gitlab-mr-train run <train.yaml> [--train <slug>] [--execute]
  gitlab-mr-train resume [--train <slug>] [--execute]
  gitlab-mr-train reset <step-id> [--train <slug>]

Trains live under ~/.config/gitlab-mr-train/trains/<slug>/.
Isolated git clones live under ~/.config/gitlab-mr-train/workspaces/<slug>/.
Your local repo paths in repos.yaml are not modified during execute mode.

Install:
  brew install https://raw.githubusercontent.com/you/gitlab-release-train/main/Formula/gitlab-mr-train.rb

Default mode is dry-run. Use --execute for real glab/git/npm actions.`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
