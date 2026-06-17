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

async function createRepo(taskId: string, options: { remote?: boolean } = {}) {
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
  if (options.remote !== false) {
    await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  }
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

    const status = await memoryStatus(repo);
    expect(status).toContain("Scope: git-remote");
    expect(status).toContain("Canonical source:");
    expect(status).toContain("Pending events: 0 (evidence=0, notes=0)");
    expect(status).toContain("Pending bytes: 0 (evidence=0, notes=0)");
    expect(status).toContain(
      "Files: memory_summary.md=no, MEMORY.md=yes, stage1-outputs.jsonl=no",
    );
    await expect(searchMemory(repo, "verification")).resolves.toEqual([
      { file: "MEMORY.md", line: 2, text: "Use npm test for verification." },
    ]);
  });

  it("reports existing path-scoped status from by-path", async ({ task }) => {
    const { repo, context } = await createRepo(task.id, { remote: false });
    await writeFile(
      join(context.memoryRoot, "MEMORY.md"),
      "path memory",
      "utf8",
    );

    const status = await memoryStatus(repo);

    expect(context.memoryRoot).toContain("/by-path/");
    expect(status).toContain(`Project memory: ${context.memoryRoot}`);
    expect(status).toContain("Scope: path");
    expect(status).toContain("Seen roots: 1");
    expect(status).toContain("Pending events: 0 (evidence=0, notes=0)");
    expect(status).toContain(
      "Files: memory_summary.md=no, MEMORY.md=yes, stage1-outputs.jsonl=no",
    );
  });

  it("reports legacy mixed layouts and backlog diagnostics", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      "## Memory Index\nold summary",
      "utf8",
    );
    await writeFile(join(context.memoryRoot, "facts.jsonl"), "[]\n", "utf8");
    await writeFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "{}\n",
      "utf8",
    );
    await writeFile(join(context.memoryRoot, "git-state.json"), "{}\n", "utf8");
    await writeFile(
      join(context.memoryRoot, "evidence.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "ev_a",
        kind: "evidence",
        source: "command",
        createdAt: "2026-06-15T10:00:00.000Z",
        evidence: [{ type: "assistant", content: "remember this" }],
        changedFilesStatTruncated: false,
        commands: [],
      })}\n{not json}\n`,
      "utf8",
    );

    const status = await memoryStatus(repo);
    expect(status).toContain("Pending events: 1 (evidence=1, notes=0)");
    expect(status).toContain("Pending malformed lines: evidence=1, notes=0");
    expect(status).toContain("Pending oldest: 2026-06-15T10:00:00.000Z");
    expect(status).toContain(
      "Legacy layout: facts.jsonl, pending-events.jsonl, git-state.json, memory_summary.md(unversioned)",
    );
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

  // ── Phase 2: status surfaces outcome + skip reasons ────────────

  it("memoryStatus shows last consolidation outcome when state file exists", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    // Write a simulated consolidation outcome state
    await writeFile(
      join(context.memoryRoot, "consolidation-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        lastOutcome: {
          at: "2026-06-15T12:00:00.000Z",
          mode: "model",
          applied: 3,
          pendingConfirmation: 0,
          reason: undefined,
          inputEstimate: 5000,
          outputEstimate: 1200,
        },
      }),
      "utf8",
    );

    const status = await memoryStatus(repo);
    expect(status).toContain("Last consolidation: model (applied 3)");
    expect(status).toContain("Last consolidation at: 2026-06-15T12:00:00.000Z");
  });

  it("memoryStatus shows last phase2 agent outcome when present", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "consolidation-state.json"),
      JSON.stringify({
        schemaVersion: 1,
        lastOutcome: {
          at: "2026-06-15T12:00:00.000Z",
          mode: "model",
          applied: 1,
          pendingConfirmation: 0,
          inputEstimate: 1000,
          outputEstimate: 200,
          phase2Agent: { status: "error", reason: "model failed" },
        },
      }),
      "utf8",
    );

    const status = await memoryStatus(repo);
    expect(status).toContain("Last phase2 agent: error (model failed)");
  });

  it("memoryStatus shows last auto-update skip reason when state has one", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    // Write auto-update state with a skip reason
    await writeFile(
      join(context.memoryRoot, "auto-update.json"),
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        lastSkipReason: "min interval",
      }),
      "utf8",
    );

    const status = await memoryStatus(repo);
    expect(status).toContain("Last auto-update skip: min interval");
  });

  it("memoryStatus omits outcome lines when no state exists", async ({
    task,
  }) => {
    const { repo } = await createRepo(task.id);
    const status = await memoryStatus(repo);
    expect(status).not.toContain("Last consolidation:");
    expect(status).not.toContain("Last auto-update skip:");
  });
});
