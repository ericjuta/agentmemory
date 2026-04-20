import { execFile } from "node:child_process";
import { resolve } from "node:path";

export interface WorktreeInfo {
  isWorktree: boolean;
  branch: string | null;
  topLevel: string;
  mainRepoRoot: string;
  gitDir: string | null;
  commonDir: string | null;
}

function execAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolveValue, reject) => {
    execFile(cmd, args, { cwd, timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolveValue(stdout.trim());
    });
  });
}

export async function detectWorktreeInfo(cwd: string): Promise<WorktreeInfo> {
  try {
    const gitDir = await execAsync("git", ["rev-parse", "--git-dir"], cwd);
    const commonDir = await execAsync("git", ["rev-parse", "--git-common-dir"], cwd);
    const branch = await execAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(
      () => "detached",
    );
    const topLevel = await execAsync("git", ["rev-parse", "--show-toplevel"], cwd);

    const isWorktree = resolve(cwd, gitDir) !== resolve(cwd, commonDir);
    const mainRepoRoot = isWorktree ? resolve(cwd, commonDir, "..") : topLevel;

    return {
      isWorktree,
      branch,
      topLevel,
      mainRepoRoot,
      gitDir: resolve(cwd, gitDir),
      commonDir: resolve(cwd, commonDir),
    };
  } catch {
    return {
      isWorktree: false,
      branch: null,
      topLevel: cwd,
      mainRepoRoot: cwd,
      gitDir: null,
      commonDir: null,
    };
  }
}

export async function listWorktrees(cwd: string): Promise<
  Array<{ path: string; head: string; branch: string; bare: boolean }>
> {
  try {
    const output = await execAsync("git", ["worktree", "list", "--porcelain"], cwd);
    const worktrees: Array<{
      path: string;
      head: string;
      branch: string;
      bare: boolean;
    }> = [];

    const blocks = output.split("\n\n").filter(Boolean);
    for (const block of blocks) {
      const lines = block.split("\n");
      const worktree = { path: "", head: "", branch: "", bare: false };
      for (const line of lines) {
        if (line.startsWith("worktree ")) worktree.path = line.slice(9);
        else if (line.startsWith("HEAD ")) worktree.head = line.slice(5);
        else if (line.startsWith("branch ")) {
          worktree.branch = line.slice(7).replace("refs/heads/", "");
        } else if (line === "bare") {
          worktree.bare = true;
        }
      }
      if (worktree.path) worktrees.push(worktree);
    }

    return worktrees;
  } catch {
    return [];
  }
}
