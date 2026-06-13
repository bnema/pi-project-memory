import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai";
import { consolidateProjectMemory } from "../src/consolidation";
import { appendPendingEvent, buildNoteEvent } from "../src/events";
import { pathExists, resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));
const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string) {
  const repo = join("/tmp", `pm-consolidation-repo-${process.pid}-${taskId}`);
  const memoryRoot = join(
    "/tmp",
    `pm-consolidation-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = await resolveMemoryContext(repo);
  if (!context) throw new Error("expected memory context");
  return { context };
}

afterEach(async () => {
  mockedComplete.mockReset();
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("consolidation cutover", () => {
  it("writes explicit manual notes to manual-notes and artifacts without model", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(
      context,
      buildNoteEvent("Remember token=secret manual note", "tool"),
    );

    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result).toMatchObject({
      mode: "manual",
      applied: 1,
      pendingConfirmation: 0,
    });
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(
      await readFile(join(context.memoryRoot, "manual-notes.jsonl"), "utf8"),
    ).toContain("[REDACTED]");
    expect(
      await readFile(join(context.memoryRoot, "MEMORY.md"), "utf8"),
    ).toContain("Manual Notes");
    await expect(
      readFile(join(context.memoryRoot, "facts.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
    expect(
      await readFile(join(context.memoryRoot, "trusted-notes.jsonl"), "utf8"),
    ).toBe("");
  });

  it("preserves evidence backlog when no model is available", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(
      context,
      buildNoteEvent("Manual project note", "tool"),
    );
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_auto",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      evidence: [
        { type: "assistant", content: "Architecture: routes and workers." },
      ],
      changedFilesStatTruncated: false,
      commands: [],
    });

    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result).toMatchObject({
      mode: "manual",
      applied: 1,
      reason: "no model registry",
    });
    expect(
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8"),
    ).toContain("checkpoint_auto");
    expect(
      await readFile(join(context.memoryRoot, "memory_summary.md"), "utf8"),
    ).toContain("manual note");
  });

  it("runs stage1 extraction for evidence and regenerates artifacts", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_model",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Capture architecture",
      evidence: [
        {
          type: "assistant",
          content: "Project uses workers for background jobs.",
        },
      ],
      changedFilesStatTruncated: false,
      commands: ["npm test"],
    });
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Uses workers for background jobs. Run npm test.",
            rollout_summary: "Worker architecture",
            rollout_slug: "worker-architecture",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);
    const fakeModel = { provider: "fake", id: "model" } as never;

    const result = await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "key" };
        },
      },
    });

    expect(result).toMatchObject({ mode: "model", applied: 1 });
    expect(
      await readFile(join(context.memoryRoot, "stage1-outputs.jsonl"), "utf8"),
    ).toContain("worker-architecture");
    expect(
      await readFile(join(context.memoryRoot, "MEMORY.md"), "utf8"),
    ).toContain("Uses workers");
    expect(
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8"),
    ).toBe("");
  });

  it("treats stage1 no-output as processed without writing artifacts from facts", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_empty",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      evidence: [{ type: "assistant", content: "ok" }],
      changedFilesStatTruncated: false,
      commands: [],
    });
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "",
            rollout_summary: "",
            rollout_slug: "empty",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);
    const fakeModel = { provider: "fake", id: "model" } as never;

    const result = await consolidateProjectMemory(context, {
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "key" };
        },
      },
    });

    expect(result).toMatchObject({
      mode: "skipped",
      reason: "model produced no durable memory",
    });
    expect(
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8"),
    ).toBe("");
    expect(await pathExists(join(context.memoryRoot, "facts.jsonl"))).toBe(
      false,
    );
  });
});
