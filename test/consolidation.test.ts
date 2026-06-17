import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai";
import {
  consolidateProjectMemory,
  readConsolidationOutcome,
} from "../src/consolidation";
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
  it("records a skipped no-pending-events outcome for status surfaces", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);

    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result).toMatchObject({
      mode: "skipped",
      reason: "no pending events",
      applied: 0,
    });
    expect(await readConsolidationOutcome(context.memoryRoot)).toMatchObject({
      lastOutcome: {
        mode: "skipped",
        reason: "no pending events",
        applied: 0,
      },
    });
    expect(
      await readFile(join(context.memoryRoot, "update-log.jsonl"), "utf8"),
    ).toContain("no pending events");
  });

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
    ).toContain("Manual project note");
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

  // ── Phase 2 consolidation: failing tests ──────────────────────────

  it("consolidates duplicate stage1 entries across multiple runs instead of accumulating them verbatim", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    const fakeModel = { provider: "google", id: "gemini-flash" } as never;

    // First consolidation run — browse-pass hardening
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "browse-pass-1",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-13T10:00:00.000Z",
      objective: "Browse-pass hardening",
      evidence: [
        {
          type: "assistant",
          content: "Added timeout and retry to browse-pass.",
        },
      ],
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
            raw_memory: "Browse-pass now has timeout and retry logic.",
            rollout_summary: "Browse-pass hardening",
            rollout_slug: "browse-pass-hardening",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    // Second consolidation run — same flow, different slug
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "browse-pass-2",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-14T10:00:00.000Z",
      objective: "Browse-pass hardening follow-up",
      evidence: [
        {
          type: "assistant",
          content: "Improved retry backoff for browse-pass.",
        },
      ],
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
            raw_memory:
              "Browse-pass retry backoff improved with exponential strategy.",
            rollout_summary: "Browse-pass backoff",
            rollout_slug: "browse-pass-backoff",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    const memory = await readFile(
      join(context.memoryRoot, "MEMORY.md"),
      "utf8",
    );

    // Phase 2: related stage1 entries about the same browse-pass flow
    // should consolidate into ONE cohesive section (one heading), not
    // survive as two separate H3 headings under a generic section heading.
    expect(memory).toContain("Browse-pass now has timeout and retry logic");
    expect(memory).toContain(
      "Browse-pass retry backoff improved with exponential strategy",
    );
    const browsePassHeadings = memory.match(/^#{2,3}\s+[Bb]rowse-pass /gm);
    expect(browsePassHeadings).toHaveLength(1);
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

  // ── Phase 4: rejected-low-quality handling ──────────────────────

  it("runs phase2 agent after preparing intermediate artifacts when UI context is available", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_agentic",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      evidence: [{ type: "assistant", content: "Found worker architecture." }],
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
            raw_memory: "Workers run queue jobs through src/workers.ts.",
            rollout_summary: "Worker Architecture",
            rollout_slug: "worker-architecture",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);
    const fakeModel = { provider: "fake", id: "model" } as never;
    const runPhase2Agent = vi.fn(async (memoryRoot: string) => {
      expect(await pathExists(join(memoryRoot, "raw_memories.md"))).toBe(true);
      expect(await pathExists(join(memoryRoot, "rollout_summaries"))).toBe(
        true,
      );
      return { status: "ok" as const };
    });

    await consolidateProjectMemory(context, {
      hasUI: true,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
      runPhase2Agent,
    });

    expect(runPhase2Agent).toHaveBeenCalledOnce();
  });

  it("treats rejected-low-quality stage1 output as processed without persisting junk", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "low_quality_ev",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Implement auth",
      evidence: [
        {
          type: "assistant",
          content: "Working on auth on feature/auth branch. Set up routes.",
        },
      ],
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
            raw_memory:
              "Working on implementing the authentication flow on the feature/auth branch.",
            rollout_summary: "Authentication task progress",
            rollout_slug: "auth-task-progress",
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
    // Evidence is consumed (processed) despite rejection
    expect(
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8"),
    ).toBe("");
    // No stage1 output was persisted
    const stage1Path = join(context.memoryRoot, "stage1-outputs.jsonl");
    const stage1Content = await readFile(stage1Path, "utf8").catch(() => "");
    expect(stage1Content).toBe("");
  });
});

describe("strict file-specific parsing", () => {
  it("must not promote a note-shaped line in evidence.jsonl as a trusted manual note", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);

    // Directly write a note-shaped line into evidence.jsonl (simulating misrouted data)
    const noteEvent = buildNoteEvent("Test: note in evidence file", "tool");
    const evidencePath = join(context.memoryRoot, "evidence.jsonl");
    await writeFile(evidencePath, JSON.stringify(noteEvent) + "\n", "utf8");

    await consolidateProjectMemory(context, { hasUI: false });

    // The note should NOT have been promoted to a manual note
    const manualNotesPath = join(context.memoryRoot, "manual-notes.jsonl");
    const manualNotesContent = await readFile(manualNotesPath, "utf8").catch(
      () => "",
    );
    expect(manualNotesContent).not.toContain(noteEvent.id);

    // The note line should remain in evidence.jsonl (not consumed)
    const evidenceContent = await readFile(evidencePath, "utf8");
    expect(evidenceContent).toContain(noteEvent.id);
  });

  it("recovers gracefully when evidence.jsonl exceeds the byte limit", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    const evidencePath = join(context.memoryRoot, "evidence.jsonl");

    // Write enough large events to push past the 500KB read limit without
    // triggering the append-time prune (which would mask the oversized state).
    let content = "";
    for (let i = 0; i < 8; i++) {
      content +=
        JSON.stringify({
          schemaVersion: 1,
          id: `oversized_${i}`,
          kind: "evidence",
          source: "command",
          createdAt: new Date(i).toISOString(),
          objective: `Large objective ${i}`,
          evidence: [
            {
              type: "assistant",
              content: "x".repeat(75_000),
            },
          ],
          changedFilesStatTruncated: false,
          commands: [],
        }) + "\n";
    }
    await writeFile(evidencePath, content, "utf8");
    expect(Buffer.byteLength(content, "utf8")).toBeGreaterThan(500_000);

    // Consolidation must not throw — it should read what fits
    const fakeModel = { provider: "google", id: "gemini-flash" } as never;
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Recovered from oversized file.",
            rollout_summary: "Oversized recovery",
            rollout_slug: "oversized-recovery",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    // Should have processed at least one event (the ones that fit in 500KB)
    expect(result).toBeDefined();
    expect(result.mode).toBe("model");
    expect(result.applied).toBe(1);
    // With bounded batch processing (MAX_BATCH_EVENTS=5), the newest 5 of
    // the events that fit in the 500KB read window are processed and
    // removed. Events beyond the read window or below the batch limit
    // survive.
    // Events 0-5 fit in the 500KB read window (6 events). Sorted newest
    // first, the batch takes events [5,4,3,2,1]. Event 0 survives the
    // batch. Events 6-7 survive because they were beyond the 500KB window.
    const remainingContent = await readFile(evidencePath, "utf8");
    // Event 5 is in the batch — removed
    expect(remainingContent).not.toContain("oversized_5");
    // Event 0 is below batch limit — survives
    expect(remainingContent).toContain("oversized_0");
    // Event 7 is beyond the 500KB read window — survives
    expect(remainingContent).toContain("oversized_7");
  });

  it("must not process an evidence-shaped line in trusted-notes.jsonl as evidence", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);

    // Write an evidence-shaped line directly into trusted-notes.jsonl
    const evidenceEvent = {
      schemaVersion: 1,
      id: "rogue_evidence_in_notes",
      kind: "evidence" as const,
      source: "command" as const,
      createdAt: "2026-06-07T00:00:00.000Z",
      evidence: [
        { type: "assistant" as const, content: "Should not be consumed" },
      ],
      changedFilesStatTruncated: false,
      commands: ["echo bad"],
    };
    const trustedPath = join(context.memoryRoot, "trusted-notes.jsonl");
    await writeFile(trustedPath, JSON.stringify(evidenceEvent) + "\n", "utf8");

    // Provide a model that would succeed if the evidence were processed
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "bad",
            rollout_summary: "bad",
            rollout_slug: "bad",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const fakeModel = { provider: "fake", id: "model" } as never;

    await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "key" };
        },
      },
    });

    // The evidence line should NOT have been consumed/removed from trusted-notes.jsonl
    const trustedContent = await readFile(trustedPath, "utf8");
    expect(trustedContent).toContain("rogue_evidence_in_notes");
  });

  // ── Phase 2: bounded batch + outcome visibility ─────────────────

  it("processes a bounded backlog slice of pending events when no eventIds are given", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    // Create 8 evidence events — more than the max batch size
    for (let i = 0; i < 8; i++) {
      await appendPendingEvent(context, {
        schemaVersion: 1,
        id: `batch_ev_${i}`,
        kind: "evidence",
        source: "command",
        createdAt: new Date(1000 * i).toISOString(),
        objective: `Batch event ${i}`,
        evidence: [{ type: "assistant", content: `Content ${i}` }],
        changedFilesStatTruncated: false,
        commands: [],
      });
    }

    const fakeModel = { provider: "google", id: "gemini-flash" } as never;
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Batch processed memory.",
            rollout_summary: "Batch",
            rollout_slug: "batch",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    // The batch should have processed at least one event but not all 8
    expect(result.applied).toBe(1);
    expect(result.mode).toBe("model");
    // Remaining events should still be in the file
    const remaining = await readFile(
      join(context.memoryRoot, "evidence.jsonl"),
      "utf8",
    );
    const lineCount = remaining.split("\n").filter((l) => l.trim()).length;
    // At least 3 events remain (8 total, max batch 5 processed)
    expect(lineCount).toBeGreaterThanOrEqual(3);
  });

  it("writes consolidation outcome state that status can read", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "outcome_ev",
      kind: "evidence",
      source: "command",
      createdAt: "2026-06-15T10:00:00.000Z",
      objective: "Track outcome",
      evidence: [{ type: "assistant", content: "outcome content" }],
      changedFilesStatTruncated: false,
      commands: [],
    });

    const fakeModel = { provider: "google", id: "gemini-flash" } as never;
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Outcome memory.",
            rollout_summary: "Outcome",
            rollout_slug: "outcome",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    // The consolidation state file should be written
    const stateStr = await readFile(
      join(context.memoryRoot, "consolidation-state.json"),
      "utf8",
    );
    const state = JSON.parse(stateStr);
    expect(state.schemaVersion).toBe(1);
    expect(state.lastOutcome).toBeDefined();
    expect(state.lastOutcome.mode).toBe("model");
    expect(state.lastOutcome.applied).toBe(1);
    expect(typeof state.lastOutcome.at).toBe("string");
    expect(typeof state.lastOutcome.inputEstimate).toBe("number");
  });
});
