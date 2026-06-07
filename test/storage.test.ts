import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  initializeMemoryStorage,
  assertInsideMemoryRoot,
  memoryRootForProject,
  withMemoryLock,
} from "../src/storage";
import type { ProjectIdentity } from "../src/types";

const PROJECT_ID = "a".repeat(64);

function identity(overrides: Partial<ProjectIdentity> = {}): ProjectIdentity {
  return {
    projectId: PROJECT_ID,
    canonicalSource: "github.com/org/repo",
    scope: "git-remote",
    gitRoot: "/tmp/repo",
    remoteUrl: "git@github.com:org/repo.git",
    ...overrides,
  };
}

describe("storage", () => {
  it("creates private project metadata and preserves aliases/seen roots", async ({
    task,
  }) => {
    const root = join("/tmp", `pi-project-memory-${process.pid}-${task.id}`);

    const first = await initializeMemoryStorage(identity(), {
      root,
      now: () => new Date("2026-06-07T00:00:00.000Z"),
    });
    const second = await initializeMemoryStorage(
      identity({
        gitRoot: "/tmp/worktree",
        remoteUrl: "https://github.com/org/repo",
      }),
      { root, now: () => new Date("2026-06-07T01:00:00.000Z") },
    );

    expect(first.memoryRoot).toBe(second.memoryRoot);
    expect(second.metadata.aliases).toEqual([
      "git@github.com:org/repo.git",
      "https://github.com/org/repo",
    ]);
    expect(second.metadata.seenRoots).toEqual(["/tmp/repo", "/tmp/worktree"]);
    expect(second.metadata.createdAt).toBe("2026-06-07T00:00:00.000Z");
    expect(second.metadata.lastSeenAt).toBe("2026-06-07T01:00:00.000Z");

    const projectJson = JSON.parse(
      await readFile(join(second.memoryRoot, "project.json"), "utf8"),
    );
    expect(projectJson.projectId).toBe(PROJECT_ID);
  });

  it("rejects invalid project ids before building memory paths", () => {
    expect(() => memoryRootForProject("../escape")).toThrow(/sha256/);
    expect(memoryRootForProject(PROJECT_ID)).toContain(PROJECT_ID);
  });

  it("rejects poisoned symlink project memory roots", async ({ task }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-poison-${process.pid}-${task.id}`,
    );
    await mkdir(join(root, "by-remote"), { recursive: true });
    await symlink("/tmp", join(root, "by-remote", PROJECT_ID));

    await expect(initializeMemoryStorage(identity(), { root })).rejects.toThrow(
      /symlink/,
    );
  });

  it("reports corrupt metadata as a controlled error", async ({ task }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-corrupt-${process.pid}-${task.id}`,
    );
    const first = await initializeMemoryStorage(identity(), { root });
    await writeFile(join(first.memoryRoot, "project.json"), "{ nope", "utf8");

    await expect(initializeMemoryStorage(identity(), { root })).rejects.toThrow(
      /Invalid project metadata JSON/,
    );
  });

  it("rejects path traversal and symlink escapes", async ({ task }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-safe-${process.pid}-${task.id}`,
    );
    await mkdir(root, { recursive: true });
    await mkdir(join(root, "inside"), { recursive: true });
    await symlink("/tmp", join(root, "outside-link"));

    await expect(assertInsideMemoryRoot(root, "inside/file.txt")).resolves.toBe(
      join(root, "inside", "file.txt"),
    );
    await expect(
      assertInsideMemoryRoot(root, "inside/new/deep/file.txt"),
    ).resolves.toBe(join(root, "inside", "new", "deep", "file.txt"));
    await expect(assertInsideMemoryRoot(root, "../escape.txt")).rejects.toThrow(
      /escapes/,
    );
    await expect(
      assertInsideMemoryRoot(root, "outside-link/escape.txt"),
    ).rejects.toThrow(/escapes/);
    await expect(assertInsideMemoryRoot(root, "/absolute")).rejects.toThrow(
      /relative/,
    );
  });

  it("serializes lock contenders without stale destructive removal", async ({
    task,
  }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-lock-timeout-${process.pid}-${task.id}`,
    );
    await mkdir(root, { recursive: true });

    await expect(
      withMemoryLock(root, "update.lock", async () =>
        withMemoryLock(root, "update.lock", async () => "nested"),
      ),
    ).rejects.toThrow();
  }, 7_000);

  it("waits instead of removing lock directories with missing owners", async ({
    task,
  }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-missing-owner-lock-${process.pid}-${task.id}`,
    );
    await mkdir(join(root, "locks", "update.lock"), { recursive: true });

    await expect(
      withMemoryLock(root, "update.lock", async () => "bad"),
    ).rejects.toThrow();
  }, 7_000);

  it("waits instead of removing lock directories with invalid owner pids", async ({
    task,
  }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-invalid-pid-lock-${process.pid}-${task.id}`,
    );
    await mkdir(join(root, "locks", "update.lock"), { recursive: true });
    await writeFile(
      join(root, "locks", "update.lock", "owner"),
      JSON.stringify({
        token: "invalid",
        pid: 0,
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );

    await expect(
      withMemoryLock(root, "update.lock", async () => "bad"),
    ).rejects.toThrow();
  }, 7_000);

  it("recovers lock directories owned by dead processes", async ({ task }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-dead-lock-${process.pid}-${task.id}`,
    );
    await mkdir(join(root, "locks", "update.lock"), { recursive: true });
    await writeFile(
      join(root, "locks", "update.lock", "owner"),
      JSON.stringify({
        token: "dead",
        pid: 999_999_999,
        createdAt: "2026-06-07T00:00:00.000Z",
      }),
    );

    await expect(
      withMemoryLock(root, "update.lock", async () => "ok"),
    ).resolves.toBe("ok");
  });

  it("cleans up lock directories and rejects unsafe lock names", async ({
    task,
  }) => {
    const root = join(
      "/tmp",
      `pi-project-memory-lock-${process.pid}-${task.id}`,
    );
    await mkdir(root, { recursive: true });

    const result = await withMemoryLock(root, "update.lock", async () => "ok");
    expect(result).toBe("ok");
    await expect(
      withMemoryLock(root, "../escape", async () => "bad"),
    ).rejects.toThrow(/safe basename/);
  });
});
