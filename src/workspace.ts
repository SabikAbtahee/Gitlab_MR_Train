import { access, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CommandRunner } from "./command.js";
import type { RepoConfig } from "./config.js";
import { workspaceDir } from "./paths.js";

export class WorkspaceManager {
  constructor(
    private readonly trainId: string,
    private readonly runner: CommandRunner
  ) {}

  async ensureClone(repoId: string, repo: RepoConfig): Promise<string> {
    const clonePath = join(workspaceDir(this.trainId), repoId);

    if (!this.runner.execute) {
      console.log(`[dry-run] would clone ${repo.gitlab} -> ${clonePath}`);
      return clonePath;
    }

    try {
      await access(join(clonePath, ".git"));
      return clonePath;
    } catch {
      // ponytail: clone below
    }

    const url = cloneUrl(repo);
    console.log(`Cloning ${repoId} into ${clonePath}`);
    await this.runner.run("git", [
      "clone",
      url,
      clonePath,
      "--branch",
      repo.mainBranch,
      "--single-branch"
    ]);

    return clonePath;
  }

  async checkoutMain(repoId: string, repo: RepoConfig): Promise<string> {
    const clonePath = await this.ensureClone(repoId, repo);
    if (!this.runner.execute) {
      console.log(`[dry-run] would checkout ${repo.mainBranch} in ${clonePath}`);
      return clonePath;
    }

    await this.runner.run("git", ["fetch", "origin"], { cwd: clonePath });
    await this.runner.run("git", ["checkout", repo.mainBranch], { cwd: clonePath });
    await this.runner.run("git", ["pull", "origin", repo.mainBranch], { cwd: clonePath });
    return clonePath;
  }

  async checkoutBranch(repoId: string, repo: RepoConfig, branch: string): Promise<string> {
    const clonePath = await this.ensureClone(repoId, repo);
    if (!this.runner.execute) {
      console.log(`[dry-run] would checkout ${branch} in ${clonePath}`);
      return clonePath;
    }

    await this.runner.run("git", ["fetch", "origin"], { cwd: clonePath });
    await this.runner.run("git", ["checkout", branch], { cwd: clonePath });
    await this.runner.run("git", ["pull", "origin", branch], { cwd: clonePath });
    return clonePath;
  }

  withPath(repo: RepoConfig, path: string): RepoConfig {
    return { ...repo, path };
  }

  async cleanup(): Promise<void> {
    const dir = workspaceDir(this.trainId);
    if (!this.runner.execute) {
      console.log(`[dry-run] would remove workspace ${dir}`);
      return;
    }

    try {
      await access(dir);
      await rm(dir, { recursive: true, force: true });
      console.log(`Removed workspace ${dir}`);
    } catch {
      // ponytail: already gone
    }
  }
}

function cloneUrl(repo: RepoConfig): string {
  const url = repo.gitlab.replace(/\/$/, "");
  return url.endsWith(".git") ? url : `${url}.git`;
}
