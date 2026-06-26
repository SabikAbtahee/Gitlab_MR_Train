import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type StepStatus =
  | "pending"
  | "waiting_mr_ready"
  | "merging"
  | "waiting_main_pipeline"
  | "packing"
  | "updating_dependents"
  | "done"
  | "failed";

export type StepState = {
  status: StepStatus;
  version?: string;
  pipelineId?: number;
  error?: string;
  updatedAt: string;
};

export type RunState = {
  trainId: string;
  trainFile: string;
  execute: boolean;
  createdAt: string;
  updatedAt: string;
  steps: Record<string, StepState>;
  versions: Record<string, string>;
};

export function newRunState(
  trainId: string,
  trainFile: string,
  execute: boolean,
  stepIds: string[]
): RunState {
  const now = new Date().toISOString();
  return {
    trainId,
    trainFile,
    execute,
    createdAt: now,
    updatedAt: now,
    versions: {},
    steps: Object.fromEntries(
      stepIds.map((id) => [
        id,
        {
          status: "pending",
          updatedAt: now
        }
      ])
    )
  };
}

export async function readState(path: string): Promise<RunState> {
  return JSON.parse(await readFile(path, "utf8")) as RunState;
}

export async function writeState(path: string, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, path);
}

export function setStep(state: RunState, stepId: string, status: StepStatus, patch: Partial<StepState> = {}): void {
  state.steps[stepId] = {
    ...state.steps[stepId],
    ...patch,
    status,
    updatedAt: new Date().toISOString()
  };
}

export function resetStepForRerun(state: RunState, stepId: string, downstreamIds: string[] = []): void {
  const current = state.steps[stepId];
  if (!current) throw new Error(`Unknown step "${stepId}"`);

  setStep(state, stepId, "waiting_main_pipeline", {
    pipelineId: current.pipelineId,
    version: undefined,
    error: undefined
  });
  delete state.versions[stepId];

  for (const downstreamId of downstreamIds) {
    setStep(state, downstreamId, "pending", {
      pipelineId: undefined,
      version: undefined,
      error: undefined
    });
    delete state.versions[downstreamId];
  }
}
