import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

const repoSchema = z.object({
  name: z.string().optional(),
  path: z.string().min(1),
  gitlab: z.string().min(1),
  mainBranch: z.string().min(1),
  packageName: z.string().optional(),
  packageJson: z.string().default("package.json"),
  versionPackageJson: z.string().optional(),
  dependencyPackageJsons: z.array(z.string()).optional()
}).transform((repo) => ({
  ...repo,
  versionPackageJson: repo.versionPackageJson ?? repo.packageJson,
  dependencyPackageJsons: repo.dependencyPackageJsons ?? [repo.packageJson]
}));

const reposSchema = z.object({
  repos: z.record(z.string(), repoSchema)
});

const packSchema = z.union([
  z.literal("none"),
  z.literal("patch"),
  z.literal("minor"),
  z.literal("major"),
  z.object({
    type: z.enum(["gitlabJob", "localCommand"]),
    job: z.string().optional(),
    command: z.string().optional()
  })
]);

const updatePackageSchema = z.object({
  from: z.string().min(1),
  packageName: z.string().optional()
});

const stepSchema = z.object({
  id: z.string().min(1),
  repo: z.string().min(1),
  mr: z.union([z.number(), z.string()]).optional(),
  dependsOn: z.array(z.string()).default([]),
  updatePackages: z.array(updatePackageSchema).default([]),
  pack: packSchema.default("none")
});

const trainSchema = z.object({
  name: z.string().min(1),
  reposFile: z.string().default("config/repos.yaml"),
  pollSeconds: z.number().int().positive().default(60),
  steps: z.array(stepSchema).min(1)
});

export type RepoConfig = z.infer<typeof repoSchema>;
export type ReposConfig = z.infer<typeof reposSchema>;
export type TrainConfig = z.infer<typeof trainSchema>;
export type TrainStep = TrainConfig["steps"][number];
export type PackConfig = TrainStep["pack"];

export async function loadYamlFile<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const content = await readFile(path, "utf8");
  return schema.parse(parseYaml(content));
}

export async function loadRepos(path: string): Promise<ReposConfig> {
  return loadYamlFile(path, reposSchema);
}

export async function loadTrain(path: string): Promise<TrainConfig> {
  return loadYamlFile(path, trainSchema);
}

export function topoSortSteps(steps: TrainStep[]): TrainStep[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: TrainStep[] = [];

  function visit(step: TrainStep): void {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) {
      throw new Error(`Dependency cycle detected at step "${step.id}"`);
    }

    visiting.add(step.id);
    for (const dependencyId of step.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (!dependency) {
        throw new Error(`Step "${step.id}" depends on unknown step "${dependencyId}"`);
      }
      visit(dependency);
    }
    visiting.delete(step.id);
    visited.add(step.id);
    sorted.push(step);
  }

  for (const step of steps) visit(step);
  return sorted;
}

export function downstreamStepIds(steps: TrainStep[], stepId: string): string[] {
  const dependents = new Set<string>();
  let changed = true;

  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.id === stepId || dependents.has(step.id)) continue;
      if (step.dependsOn.some((dep) => dep === stepId || dependents.has(dep))) {
        dependents.add(step.id);
        changed = true;
      }
    }
  }

  return topoSortSteps(steps)
    .map((step) => step.id)
    .filter((id) => dependents.has(id));
}

export function packJobName(pack: PackConfig): string | undefined {
  if (pack === "none") return undefined;
  if (typeof pack === "string") {
    // ponytail: GitLab shared templates use title case job names like "pack Minor"
    return `pack ${pack.charAt(0).toUpperCase()}${pack.slice(1)}`;
  }
  if (pack.type === "gitlabJob") return pack.job;
  return undefined;
}

export function reposToYaml(config: ReposConfig): string {
  return stringifyYaml(config);
}

export function trainToYaml(config: TrainConfig): string {
  return stringifyYaml(config);
}

export async function writeReposYaml(path: string, config: ReposConfig): Promise<void> {
  reposSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${reposToYaml(config)}\n`);
}

export async function writeTrainYaml(path: string, config: TrainConfig): Promise<void> {
  trainSchema.parse(config);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${trainToYaml(config)}\n`);
}
