import type { CommandRunner } from "./command.js";
import { packJobName, type PackConfig, type RepoConfig } from "./config.js";

type MrJson = {
  title?: string;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  pipeline?: { status?: string };
  head_pipeline?: { status?: string };
  source_branch?: string;
};

type PipelineJson = {
  id?: number;
  status?: string;
  jobs?: Array<{ id?: number; name?: string; status?: string; when?: string }>;
};

export type ApprovalRule = {
  id: number;
  name?: string;
  approvals_required?: number;
};

// ponytail: matches existing shell script threshold; bump if policy changes
export const REVOKE_TARGET_APPROVALS = 2;

export function rulesToRevoke(rules: ApprovalRule[], target = REVOKE_TARGET_APPROVALS): ApprovalRule[] {
  return rules.filter((rule) => rule.approvals_required === target);
}

export type MrReadiness = {
  ready: boolean;
  merged: boolean;
  reasons: string[];
};

export class GitLab {
  constructor(private readonly runner: CommandRunner) {}

  async mrReadiness(repo: RepoConfig, mr: string | number): Promise<MrReadiness> {
    if (!this.runner.execute) return { ready: true, merged: false, reasons: ["dry-run assumes MR ready"] };

    const data = await this.viewMr(repo, mr);
    if (data.state === "merged") {
      return { ready: true, merged: true, reasons: [] };
    }

    const reasons: string[] = [];
    const draft = data.draft ?? data.work_in_progress;
    const pipelineStatus = data.head_pipeline?.status ?? data.pipeline?.status;
    const mergeStatus = data.detailed_merge_status ?? data.merge_status;

    if (data.state !== "opened") reasons.push(`MR state is ${data.state ?? "unknown"}`);
    if (draft) reasons.push("MR is draft");
    if (pipelineStatus && pipelineStatus !== "success") reasons.push(`MR pipeline is ${pipelineStatus}`);
    if (mergeStatus && !["can_be_merged", "mergeable"].includes(mergeStatus)) {
      reasons.push(`MR merge status is ${mergeStatus}`);
    }

    return { ready: reasons.length === 0, merged: false, reasons };
  }

  async isMrMerged(repo: RepoConfig, mr: string | number): Promise<boolean> {
    if (!this.runner.execute) return false;
    const data = await this.viewMr(repo, mr);
    return data.state === "merged";
  }

  async merge(repo: RepoConfig, mr: string | number): Promise<void> {
    await this.runner.run("glab", ["mr", "merge", String(mr), "--repo", repo.gitlab, "--yes"]);
  }

  async getMrBranch(repo: RepoConfig, mr: string | number): Promise<string> {
    if (!this.runner.execute) return "feature/dry-run";

    const data = await this.viewMr(repo, mr);
    if (!data.source_branch) {
      throw new Error(`MR ${mr} has no source_branch in glab response`);
    }
    return data.source_branch;
  }

  async getPipeline(repo: RepoConfig, pipelineId: number): Promise<PipelineJson> {
    return this.runner.json<PipelineJson>("glab", [
      "ci",
      "get",
      "--repo",
      repo.gitlab,
      "--pipeline-id",
      String(pipelineId),
      "--output",
      "json",
      "--with-job-details"
    ]);
  }

  async getBranchPipeline(repo: RepoConfig): Promise<PipelineJson | undefined> {
    if (!this.runner.execute) return { id: 0, status: "success", jobs: [] };

    const pipelines = await this.runner.json<Array<{ id: number }>>("glab", [
      "ci",
      "list",
      "--repo",
      repo.gitlab,
      "--ref",
      repo.mainBranch,
      "--output",
      "json",
      "-P",
      "1"
    ]);

    const latestId = pipelines[0]?.id;
    if (!latestId) return undefined;

    return this.getPipeline(repo, latestId);
  }

  async waitForBranchPipeline(repo: RepoConfig, pollSeconds: number): Promise<PipelineJson> {
    while (true) {
      const pipeline = await this.getBranchPipeline(repo);

      if (!this.runner.execute) return { id: 0, status: "success", jobs: [] };
      if (!pipeline?.id) {
        console.log(`Waiting ${pollSeconds}s for first pipeline on ${repo.mainBranch}`);
        await sleep(pollSeconds * 1000);
        continue;
      }

      if (pipeline.status === "success") return pipeline;
      if (["failed", "canceled", "skipped"].includes(pipeline.status ?? "")) {
        throw new Error(`Pipeline ${pipeline.id} ended with status ${pipeline.status}`);
      }

      console.log(`Waiting ${pollSeconds}s for ${repo.name ?? repo.gitlab} ${repo.mainBranch} pipeline ${pipeline.id}: ${pipeline.status}`);
      await sleep(pollSeconds * 1000);
    }
  }

  async listManualJobs(repo: RepoConfig): Promise<string[]> {
    if (!this.runner.execute) return [];

    const pipeline = await this.getBranchPipeline(repo);
    if (!pipeline?.jobs?.length) return [];

    const manual = pipeline.jobs
      .filter((job) => job.when === "manual" || job.status === "manual")
      .map((job) => job.name)
      .filter((name): name is string => Boolean(name));

    const packJobs = manual.filter((name) => /pack/i.test(name));
    return packJobs.length > 0 ? packJobs : manual;
  }

  async findPackPipelineWithSuccess(repo: RepoConfig, jobName: string): Promise<PipelineJson | undefined> {
    if (!this.runner.execute) return undefined;

    const pipelines = await this.runner.json<Array<{ id: number }>>("glab", [
      "ci",
      "list",
      "--repo",
      repo.gitlab,
      "--ref",
      repo.mainBranch,
      "--output",
      "json",
      "-P",
      "10"
    ]);

    for (const entry of pipelines) {
      const pipeline = await this.getPipeline(repo, entry.id);
      const job = pipeline.jobs?.find((candidate) => candidate.name === jobName);
      if (job?.status === "success") return pipeline;
    }

    return undefined;
  }

  async runPackJob(
    repo: RepoConfig,
    pack: PackConfig,
    pipelineId: number,
    pollSeconds: number
  ): Promise<void> {
    const jobName = packJobName(pack);
    if (!jobName) return;

    if (!this.runner.execute) {
      console.log(`[dry-run] glab ci trigger '${jobName}' --pipeline-id ${pipelineId}`);
      return;
    }

    while (true) {
      const current = await this.getPipeline(repo, pipelineId);
      const job = current.jobs?.find((entry) => entry.name === jobName);
      if (!job) {
        throw new Error(`Pipeline ${pipelineId} contains no jobs with the name ${jobName}`);
      }

      const status = job.status ?? "unknown";
      if (status === "success") {
        console.log(`Pack job "${jobName}" completed on pipeline ${pipelineId}`);
        return;
      }

      if (status === "manual") {
        console.log(`Triggering pack job "${jobName}" on pipeline ${pipelineId}`);
        await this.runner.run("glab", [
          "ci",
          "trigger",
          jobName,
          "--repo",
          repo.gitlab,
          "--pipeline-id",
          String(pipelineId)
        ]);
        await sleep(pollSeconds * 1000);
        continue;
      }

      if (["failed", "canceled", "skipped"].includes(status)) {
        throw new Error(`Pack job "${jobName}" ended with status ${status} on pipeline ${pipelineId}`);
      }

      console.log(`Waiting ${pollSeconds}s for pack job "${jobName}" on pipeline ${pipelineId}: ${status}`);
      await sleep(pollSeconds * 1000);
    }
  }

  async ensurePackComplete(
    repo: RepoConfig,
    pack: PackConfig,
    mergePipelineId: number | undefined,
    pollSeconds: number
  ): Promise<number | undefined> {
    const jobName = packJobName(pack);
    if (!jobName) return mergePipelineId;

    if (!this.runner.execute) {
      console.log(`[dry-run] ensure pack "${jobName}" on pipeline ${mergePipelineId ?? "(unknown)"}`);
      return mergePipelineId;
    }

    if (!mergePipelineId) {
      const completed = await this.findPackPipelineWithSuccess(repo, jobName);
      if (completed?.id) {
        console.log(`Pack job "${jobName}" already completed on pipeline ${completed.id}`);
        return completed.id;
      }
      throw new Error(`Cannot run pack job "${jobName}" without merge pipeline id`);
    }

    const mergePipeline = await this.getPipeline(repo, mergePipelineId);
    const mergeJob = mergePipeline.jobs?.find((entry) => entry.name === jobName);
    if (mergeJob?.status === "success") {
      console.log(`Pack job "${jobName}" already completed on merge pipeline ${mergePipelineId}`);
      return mergePipelineId;
    }

    // ponytail: only pack on this merge pipeline; do not reuse success from older pipelines
    await this.runPackJob(repo, pack, mergePipelineId, pollSeconds);
    return mergePipelineId;
  }

  async listMrApprovalRules(repo: RepoConfig, mr: number): Promise<ApprovalRule[]> {
    const data = await this.runner.json<ApprovalRule[]>("glab", [
      "api",
      "--repo",
      repo.gitlab,
      `projects/:id/merge_requests/${mr}/approval_rules`
    ]);
    return Array.isArray(data) ? data : [];
  }

  async updateMrApprovalRule(
    repo: RepoConfig,
    mr: number,
    ruleId: number,
    approvalsRequired: number
  ): Promise<void> {
    await this.runner.run("glab", [
      "api",
      "--method",
      "PUT",
      "--repo",
      repo.gitlab,
      `projects/:id/merge_requests/${mr}/approval_rules/${ruleId}`,
      "-F",
      `approvals_required=${approvalsRequired}`
    ]);
  }

  private async viewMr(repo: RepoConfig, mr: string | number): Promise<MrJson> {
    return this.runner.json<MrJson>("glab", [
      "mr",
      "view",
      String(mr),
      "--repo",
      repo.gitlab,
      "--output",
      "json"
    ]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
