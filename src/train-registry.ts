import { readdir, readFile } from "node:fs/promises";
import { loadTrain } from "./config.js";
import {
  pathExists,
  trainDir,
  trainState,
  trainYaml,
  workspaceDir,
  TRAINS_DIR
} from "./paths.js";
import { readState, type RunState } from "./state.js";

export type TrainContext = {
  trainId: string;
  trainFile: string;
  stateFile: string;
  workspaceDir: string;
};

export type TrainSummary = {
  trainId: string;
  name: string;
  state: RunState;
  summary: string;
};

export function getTrainContext(trainId: string): TrainContext {
  return {
    trainId,
    trainFile: trainYaml(trainId),
    stateFile: trainState(trainId),
    workspaceDir: workspaceDir(trainId)
  };
}

export function isTrainActive(state: RunState): boolean {
  return !Object.values(state.steps).every((step) => step.status === "done");
}

export function summarizeTrain(state: RunState): string {
  const failed = Object.entries(state.steps).find(([, step]) => step.status === "failed");
  if (failed) return `failed at ${failed[0]}`;

  const pending = Object.entries(state.steps).find(
    ([, step]) => step.status !== "done" && step.status !== "failed"
  );
  if (pending) return `${pending[0]}: ${pending[1].status}`;

  return "in progress";
}

export async function listTrains(): Promise<TrainSummary[]> {
  if (!(await pathExists(TRAINS_DIR))) return [];

  const entries = await readdir(TRAINS_DIR, { withFileTypes: true });
  const summaries: TrainSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const trainId = entry.name;
    const stateFile = trainState(trainId);
    if (!(await pathExists(stateFile))) continue;

    const state = await readState(stateFile);
    let name = state.trainId || trainId;
    try {
      const train = await loadTrain(trainYaml(trainId));
      name = train.name;
    } catch {
      // ponytail: fall back to trainId
    }

    summaries.push({
      trainId,
      name,
      state,
      summary: summarizeTrain(state)
    });
  }

  return summaries.sort((a, b) => b.state.updatedAt.localeCompare(a.state.updatedAt));
}

export async function listActiveTrains(): Promise<TrainSummary[]> {
  const trains = await listTrains();
  return trains.filter((train) => isTrainActive(train.state));
}

export async function readTrainIdFromState(stateFile: string): Promise<string | undefined> {
  if (!(await pathExists(stateFile))) return undefined;
  const state = await readState(stateFile);
  return state.trainId;
}

export async function ensureUniqueTrainId(baseSlug: string): Promise<string> {
  let candidate = baseSlug;
  let suffix = 2;
  while (await pathExists(trainDir(candidate))) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}
