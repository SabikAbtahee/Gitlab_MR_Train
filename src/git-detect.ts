import { execa } from "execa";

export async function detectGitRemote(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["remote", "get-url", "origin"], { cwd: path });
    return normalizeGitLabUrl(stdout.trim());
  } catch {
    return undefined;
  }
}

export async function detectMainBranch(path: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: path });
    const match = stdout.trim().match(/refs\/remotes\/origin\/(.+)/);
    if (match?.[1]) return match[1];
  } catch {
    // ponytail: fallback scan below
  }

  try {
    const { stdout } = await execa("git", ["branch", "-r"], { cwd: path });
    if (stdout.includes("origin/main")) return "main";
    if (stdout.includes("origin/master")) return "master";
  } catch {
    return undefined;
  }

  return undefined;
}

export function normalizeGitLabUrl(url: string): string {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url.replace(/\.git$/, "");
  }

  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  return url.replace(/\.git$/, "");
}
