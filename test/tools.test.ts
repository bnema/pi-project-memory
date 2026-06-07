import { execFile } from "node:child_process";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryContext } from "../src/storage";
import { memoryStatus, readMemoryFile, searchMemory } from "../src/tools";

const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-tools-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-tools-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = await resolveMemoryContext(repo);
  if (!context) throw new Error("expected memory context");
  return { repo, memoryRoot, context };
}

afterEach(async () => {
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project memory tools", () => {
  it("reports status and searches bounded memory files", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "MEMORY.md"),
      "# Commands\nUse npm test for verification.\n",
      "utf8",
    );

    await expect(memoryStatus(repo)).resolves.toContain("Scope: git-remote");
    await expect(searchMemory(repo, "verification")).resolves.toEqual([
      { file: "MEMORY.md", line: 2, text: "Use npm test for verification." },
    ]);
  });

  it("reads safe relative files with byte caps and rejects escapes", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "MEMORY.md"),
      "hello memory",
      "utf8",
    );
    await symlink("/tmp", join(context.memoryRoot, "outside-link"));

    await expect(readMemoryFile(repo, "MEMORY.md")).resolves.toMatchObject({
      text: "hello memory",
    });
    await expect(readMemoryFile(repo, "MEMORY.md", 5)).resolves.toMatchObject({
      text: "hello",
      truncated: true,
    });
    await expect(readMemoryFile(repo, "../escape")).rejects.toThrow(/escapes/);
    await expect(readMemoryFile(repo, "outside-link/escape")).rejects.toThrow(
      /escapes/,
    );
  });
});
