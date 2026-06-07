import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeRemoteUrl, resolveProjectIdentity } from "../src/project-id";
import { initializeMemoryStorage, resolveMemoryContext } from "../src/storage";

const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string, remote?: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-failure-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-failure-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  if (remote) await git(["remote", "add", "origin", remote], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  return { repo, memoryRoot };
}

afterEach(async () => {
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("packaging failure cases", () => {
  it("falls back to path scope when origin is missing", async ({ task }) => {
    const { repo } = await createRepo(task.id);
    const identity = await resolveProjectIdentity(repo);
    expect(identity?.scope).toBe("path");
    expect(identity?.warning).toMatch(/No origin remote/);
  });

  it("keeps ssh aliases and https remotes for the same source together", async ({
    task,
  }) => {
    const first = await createRepo(
      `${task.id}-a`,
      "git@github.com:org/repo.git",
    );
    const second = await createRepo(
      `${task.id}-b`,
      "https://github.com/org/repo",
    );
    const firstContext = await resolveMemoryContext(first.repo);
    const secondContext = await resolveMemoryContext(second.repo);
    expect(firstContext?.memoryRoot).toBe(secondContext?.memoryRoot);
    expect(secondContext?.metadata.aliases).toEqual([
      "git@github.com:org/repo.git",
      "https://github.com/org/repo",
    ]);
  });

  it("keeps fork/upstream remotes distinct", () => {
    expect(normalizeRemoteUrl("git@github.com:org/repo.git")).not.toBe(
      normalizeRemoteUrl("git@github.com:user/repo.git"),
    );
  });

  it("updates aliases when a remote URL changes", async ({ task }) => {
    const { repo } = await createRepo(task.id, "git@github.com:org/repo.git");
    const first = await resolveMemoryContext(repo);
    await git(
      ["remote", "set-url", "origin", "https://github.com/org/repo"],
      repo,
    );
    const second = await resolveMemoryContext(repo);
    expect(first?.memoryRoot).toBe(second?.memoryRoot);
    expect(second?.metadata.aliases).toEqual([
      "git@github.com:org/repo.git",
      "https://github.com/org/repo",
    ]);
  });

  it("does not persist credentialed remote userinfo", async ({ task }) => {
    const { repo } = await createRepo(
      task.id,
      "https://token:secret@github.com/org/repo.git",
    );
    const context = await resolveMemoryContext(repo);
    expect(context?.metadata.aliases.join("\n")).not.toContain("token");
    expect(context?.metadata.aliases.join("\n")).not.toContain("secret");
    expect(context?.metadata.aliases).toEqual([
      "https://github.com/org/repo.git",
    ]);
  });

  it("path-scopes unsupported local remotes", async ({ task }) => {
    const { repo } = await createRepo(task.id, "/tmp/local.git");
    const context = await resolveMemoryContext(repo);
    expect(context?.metadata.scope).toBe("path");
    expect(context?.identity.warning).toMatch(/path-scoped/);
  });

  it("rejects reset-like storage escapes through invalid project ids", async ({
    task,
  }) => {
    const { memoryRoot } = await createRepo(task.id);
    await expect(
      initializeMemoryStorage(
        {
          projectId: "../bad",
          canonicalSource: "bad",
          scope: "path",
          gitRoot: "/tmp/bad",
        },
        { root: memoryRoot },
      ),
    ).rejects.toThrow(/sha256/);
  });
});
