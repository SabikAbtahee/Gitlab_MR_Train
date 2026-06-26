import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR = join(homedir(), ".config", "gitlab-mr-train");
export const REPOS_FILE = join(CONFIG_DIR, "repos.yaml");
export const TRAINS_DIR = join(CONFIG_DIR, "trains");
export const WORKSPACES_DIR = join(CONFIG_DIR, "workspaces");

export function slugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "train";
}

export function trainDir(trainId: string): string {
  return join(TRAINS_DIR, trainId);
}

export function trainYaml(trainId: string): string {
  return join(trainDir(trainId), "train.yaml");
}

export function trainState(trainId: string): string {
  return join(trainDir(trainId), "state.json");
}

export function workspaceDir(trainId: string): string {
  return join(WORKSPACES_DIR, trainId);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function hasReposConfig(): Promise<boolean> {
  return pathExists(REPOS_FILE);
}
