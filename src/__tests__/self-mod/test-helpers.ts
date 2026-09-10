/**
 * A real (not stubbed) BackendClient for tests — exec() genuinely
 * shells out via child_process, readFile/writeFile genuinely touch
 * the filesystem. self-mod/sync.ts's own tests use this instead of a
 * canned `vi.fn(async () => ({ stdout: "" }))` mock (the pattern used
 * elsewhere in this test suite) specifically because sync.ts's whole
 * job is orchestrating real git operations — a mock that always
 * returns success without running anything would test nothing about
 * whether the git commands it constructs are actually correct.
 */
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { BackendClient, ExecResult } from "../../types.js";

const exec = promisify(execCb);

export function makeRealBackend(): BackendClient {
  return {
    async exec(command: string, timeout = 10_000): Promise<ExecResult> {
      try {
        const { stdout, stderr } = await exec(command, { timeout, shell: "/bin/bash" });
        return { stdout, stderr, exitCode: 0 };
      } catch (err: any) {
        return {
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? String(err.message ?? err),
          exitCode: typeof err.code === "number" ? err.code : 1,
        };
      }
    },
    async readFile(filePath: string): Promise<string> {
      return fs.readFile(filePath, "utf8");
    },
    async writeFile(filePath: string, content: string): Promise<void> {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
    },
  } as unknown as BackendClient; // only the three methods above are exercised by anything under test
}

/**
 * Sets up a real bare "origin" repo plus a real clone of it (standing
 * in for one agent's own checkout), with git author identity
 * configured so commits don't fail in a fresh CI-style environment
 * with no global gitconfig.
 */
export async function makeGitFixture(): Promise<{
  originPath: string;
  repoPath: string;
  backend: BackendClient;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "selfmod-sync-"));
  const originPath = path.join(root, "origin.git");
  const repoPath = path.join(root, "agent-repo");
  const backend = makeRealBackend();

  await backend.exec(`git init --bare -b main ${originPath}`);
  await backend.exec(`git clone ${originPath} ${repoPath}`);
  await backend.exec(`cd ${repoPath} && git checkout -B main`);
  await backend.exec(`cd ${repoPath} && git config user.email test@example.com && git config user.name "Test Agent"`);

  return {
    originPath,
    repoPath,
    backend,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

export async function writeAndCommit(
  backend: BackendClient,
  repoPath: string,
  relativePath: string,
  content: string,
  message: string,
): Promise<void> {
  await backend.writeFile(`${repoPath}/${relativePath}`, content);
  const result = await backend.exec(`cd ${repoPath} && git add -A && git commit -m ${JSON.stringify(message)}`);
  if (result.exitCode !== 0) {
    throw new Error(`writeAndCommit failed: ${result.stderr || result.stdout}`);
  }
}
