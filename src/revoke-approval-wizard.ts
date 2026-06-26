import * as p from "@clack/prompts";
import { createCommandRunner } from "./command.js";
import { loadRepos, type RepoConfig } from "./config.js";
import { GitLab, REVOKE_TARGET_APPROVALS, rulesToRevoke } from "./gitlab.js";
import { REPOS_FILE } from "./paths.js";

export async function runRevokeApprovalWizard(): Promise<void> {
  p.intro("gitlab-mr-train — revoke MR approval");

  const repos = await loadRepos(REPOS_FILE);
  const repoIds = Object.keys(repos.repos);
  if (repoIds.length === 0) {
    p.log.error("repos.yaml has no repos. Run: gitlab-mr-train init");
    return;
  }

  while (true) {
    const done = await revokeOneMr(repos.repos);
    if (done) break;

    const again = await p.confirm({ message: "Revoke another MR?", initialValue: false });
    if (p.isCancel(again) || !again) break;
  }

  p.outro("Done.");
}

async function revokeOneMr(repos: Record<string, RepoConfig>): Promise<boolean> {
  const repoId = await p.select({
    message: "Repo",
    options: Object.entries(repos).map(([id, repo]) => ({
      value: id,
      label: `${id}${repo.name ? ` (${repo.name})` : ""}`
    }))
  });
  if (p.isCancel(repoId)) {
    p.cancel("Cancelled.");
    return true;
  }

  const repo = repos[String(repoId)]!;

  const mrRaw = await p.text({
    message: "MR number",
    validate: (value) => {
      const trimmed = value?.trim() ?? "";
      if (!/^\d+$/.test(trimmed)) return "Enter a positive MR number";
      if (Number(trimmed) <= 0) return "Enter a positive MR number";
      return undefined;
    }
  });
  if (p.isCancel(mrRaw)) {
    p.cancel("Cancelled.");
    return true;
  }

  const mr = Number(String(mrRaw).trim());
  const readGitlab = new GitLab(createCommandRunner(true));

  p.log.step(`Fetching approval rules for MR !${mr}…`);

  let allRules;
  try {
    allRules = await readGitlab.listMrApprovalRules(repo, mr);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    p.log.error(`Failed to fetch approval rules: ${message}`);
    return false;
  }

  const matching = rulesToRevoke(allRules, REVOKE_TARGET_APPROVALS);

  console.log();
  if (matching.length === 0) {
    p.log.warn(
      `No approval rules with approvals_required=${REVOKE_TARGET_APPROVALS} on MR !${mr}. Skipping.`
    );
    console.log();
    return false;
  }

  console.log(`Rules to revoke (approvals_required ${REVOKE_TARGET_APPROVALS} → 0):`);
  for (const rule of matching) {
    console.log(`  • id=${rule.id} name="${rule.name ?? "(unnamed)"}" approvals_required=${rule.approvals_required}`);
  }
  console.log();

  const execute = await p.confirm({
    message: "Execute for real? (No = dry-run)",
    initialValue: true
  });
  if (p.isCancel(execute)) {
    p.cancel("Cancelled.");
    return true;
  }

  const writeGitlab = new GitLab(createCommandRunner(execute));

  for (const rule of matching) {
    console.log(`Updating approval rule ${rule.id}: ${REVOKE_TARGET_APPROVALS} → 0`);
    try {
      await writeGitlab.updateMrApprovalRule(repo, mr, rule.id, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      p.log.error(`Failed to update rule ${rule.id}: ${message}`);
      return false;
    }
  }

  if (execute) {
    p.log.success(`Revoked ${matching.length} approval rule(s) on MR !${mr}.`);
  } else {
    p.log.info(`Dry-run complete. ${matching.length} rule(s) would be updated.`);
  }

  console.log();
  return false;
}
