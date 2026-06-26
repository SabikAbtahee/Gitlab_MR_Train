import { existsSync } from "node:fs";
import * as p from "@clack/prompts";
import {
  loadRepos,
  writeReposYaml,
  type RepoConfig,
  type ReposConfig
} from "./config.js";
import { detectGitRemote, detectMainBranch } from "./git-detect.js";
import { REPOS_FILE } from "./paths.js";

export type InitOptions = {
  add?: boolean;
  edit?: string;
};

export async function runInitWizard(options: InitOptions = {}): Promise<void> {
  p.intro("gitlab-mr-train init");

  let config: ReposConfig = { repos: {} };
  if (options.add || options.edit) {
    config = await loadRepos(REPOS_FILE);
  }

  if (options.edit) {
    const existing = config.repos[options.edit];
    if (!existing) throw new Error(`Unknown repo id "${options.edit}"`);
    config.repos[options.edit] = await promptRepo(options.edit, existing);
    await writeReposYaml(REPOS_FILE, config);
    p.outro(`Updated repo "${options.edit}" in ${REPOS_FILE}`);
    return;
  }

  while (true) {
    const id = await p.text({
      message: "Repo id (slug key, e.g. libA)",
      validate: (value) => {
        if (!value?.trim()) return "Required";
        if (!options.add && config.repos[value.trim()]) return "Id already exists";
        return undefined;
      }
    });
    if (p.isCancel(id)) {
      p.cancel("Init cancelled.");
      return;
    }

    const repoId = String(id).trim();
    config.repos[repoId] = await promptRepo(repoId);

    const again = await p.confirm({ message: "Add another repo?", initialValue: false });
    if (p.isCancel(again) || !again) break;
  }

  if (Object.keys(config.repos).length === 0) {
    p.cancel("No repos configured.");
    return;
  }

  await writeReposYaml(REPOS_FILE, config);
  p.outro(`Wrote ${REPOS_FILE}`);
}

async function promptRepo(id: string, existing?: RepoConfig): Promise<RepoConfig> {
  const pathInput = await p.text({
    message: `Local path for "${id}"`,
    initialValue: existing?.path,
    validate: (value) => {
      if (!value?.trim()) return "Required";
      if (!existsSync(value.trim())) return "Path does not exist";
      return undefined;
    }
  });
  if (p.isCancel(pathInput)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const repoPath = String(pathInput).trim();
  const detectedRemote = await detectGitRemote(repoPath);
  const detectedBranch = await detectMainBranch(repoPath);

  const name = await p.text({
    message: "Display name (optional)",
    initialValue: existing?.name ?? id
  });
  if (p.isCancel(name)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const gitlab = await p.text({
    message: "GitLab project URL",
    initialValue: existing?.gitlab ?? detectedRemote ?? "",
    validate: (value) => (value?.trim() ? undefined : "Required")
  });
  if (p.isCancel(gitlab)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const mainBranch = await p.text({
    message: "Main branch",
    initialValue: existing?.mainBranch ?? detectedBranch ?? "main",
    validate: (value) => (value?.trim() ? undefined : "Required")
  });
  if (p.isCancel(mainBranch)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const isLibrary = await p.confirm({
    message: "Publishable library (has npm package)?",
    initialValue: Boolean(existing?.packageName)
  });
  if (p.isCancel(isLibrary)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const base: RepoConfig = {
    path: repoPath,
    gitlab: String(gitlab).trim(),
    mainBranch: String(mainBranch).trim(),
    packageJson: existing?.packageJson ?? "package.json",
    versionPackageJson: existing?.versionPackageJson ?? "package.json",
    dependencyPackageJsons: existing?.dependencyPackageJsons ?? ["package.json"]
  };

  if (name && String(name).trim()) {
    base.name = String(name).trim();
  }

  if (!isLibrary) return base;

  const packageName = await p.text({
    message: "npm package name",
    initialValue: existing?.packageName ?? "",
    validate: (value) => (value?.trim() ? undefined : "Required for libraries")
  });
  if (p.isCancel(packageName)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const versionPackageJson = await p.text({
    message: "Version package.json path",
    initialValue: existing?.versionPackageJson ?? "lib/package.json"
  });
  if (p.isCancel(versionPackageJson)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  const depManifests = await p.text({
    message: "Dependency manifests (comma-separated)",
    initialValue: (existing?.dependencyPackageJsons ?? ["package.json", "lib/package.json"]).join(", ")
  });
  if (p.isCancel(depManifests)) {
    p.cancel("Init cancelled.");
    process.exit(0);
  }

  return {
    ...base,
    packageName: String(packageName).trim(),
    versionPackageJson: String(versionPackageJson).trim(),
    dependencyPackageJsons: String(depManifests)
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  };
}
