import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consolidateProjectMemory } from "../src/consolidation";
import { appendPendingEvent, buildNoteEvent } from "../src/events";
import { complete } from "@earendil-works/pi-ai";
import { readFacts, writeFacts, type ProjectFact } from "../src/facts";
import { pathExists, resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));

const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function fact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  return {
    schemaVersion: 1,
    id: "fact_one",
    kind: "observation",
    topic: "architecture",
    scope: "whole_project",
    text: "Existing fact",
    evidence: [{ type: "user", note: "test" }],
    confidence: "verified",
    status: "active",
    stalenessTriggers: [],
    sourceEventIds: ["event_one"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

async function createRepo(taskId: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-consolidation-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-consolidation-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = await resolveMemoryContext(repo);
  if (!context) throw new Error("expected memory context");
  return { repo, context };
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

describe("consolidation", () => {
  it("applies explicit manual notes without a model", async ({ task }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(
      context,
      buildNoteEvent("Remember token=secret project fact", "tool"),
    );

    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result).toMatchObject({ mode: "manual", applied: 1 });
    expect(mockedComplete).not.toHaveBeenCalled();
    const facts = await readFacts(context.memoryRoot);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).not.toContain("secret");
    expect(await pathExists(join(context.memoryRoot, "MEMORY.md"))).toBe(true);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toBe("");
  });

  it("applies manual notes and preserves checkpoints when no model is available", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    const note = buildNoteEvent("Manual project fact", "tool");
    await appendPendingEvent(context, note);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_auto",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      assistantSummary: "Project: API. Architecture: routes and workers.",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });

    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result).toMatchObject({
      mode: "manual",
      applied: 1,
      reason: "model unavailable",
    });
    expect((await readFacts(context.memoryRoot))[0]?.text).toBe(
      "Manual project fact",
    );
    const pending = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(pending).not.toContain(note.id);
    expect(pending).toContain("checkpoint_auto");
  });

  it("applies manual notes when checkpoint model output exceeds budget", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    const note = buildNoteEvent("Manual project fact", "tool");
    await appendPendingEvent(context, note);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_auto",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      assistantSummary: "Project: API. Architecture: routes and workers.",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    await writeFile(
      join(context.memoryRoot, "usage.json"),
      JSON.stringify({
        days: {
          [new Date().toISOString().slice(0, 10)]: { input: 0, output: 7_000 },
        },
      }),
    );
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            candidates: Array.from({ length: 20 }, (_, index) => ({
              action: "add",
              confirmationRequired: false,
              reason: "too large",
              fact: fact({
                id: `large_fact_${index}`,
                text: `large fact ${index} ${"x".repeat(1_200)}`,
              }),
            })),
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

    expect(result).toMatchObject({
      mode: "manual",
      applied: 1,
      reason: "model budget exhausted",
    });
    expect((await readFacts(context.memoryRoot))[0]?.text).toBe(
      "Manual project fact",
    );
    const pending = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(pending).not.toContain(note.id);
    expect(pending).toContain("checkpoint_auto");
  });

  it("keeps manual notes when model returns no checkpoint candidates", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(
      context,
      buildNoteEvent("Manual project fact", "tool"),
    );
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_auto",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      assistantSummary: "Project: API. Architecture: routes and workers.",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ candidates: [] }) }],
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
    expect((await readFacts(context.memoryRoot))[0]?.text).toBe(
      "Manual project fact",
    );
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toBe("");
  });

  it("does not write automatic checkpoint facts without a model", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_auto",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      assistantSummary:
        "Project: API. Architecture: routes and workers. Findings: auth review domain.",
      changedFilesStatTruncated: false,
      commands: ["rtk go test ./..."],
      fallbackNotes: [],
    });

    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result).toMatchObject({
      mode: "skipped",
      applied: 0,
      reason: "model unavailable",
    });
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toContain("checkpoint_auto");
  });

  it("model can write first exploration memory without confirmation", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_explore",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      assistantSummary:
        "Read-only exploration completed. What the project does: ero is a Go Bubble Tea TUI for GitHub-style diff review. Architecture map: hexagonal architecture with internal/app composition, internal/core domain logic, ports, adapters, and provider plugins.",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            candidates: [
              {
                action: "add",
                confirmationRequired: false,
                reason:
                  "first exploration produced source-backed project facts",
                fact: fact({
                  id: "fact_ero_architecture",
                  text: "Project: ero is a Go Bubble Tea TUI for GitHub-style diff review. Architecture: hexagonal architecture with internal/app composition, internal/core domain logic, ports, adapters, and provider plugins.",
                  evidence: [
                    {
                      type: "model",
                      note: "Extracted from first codebase exploration checkpoint",
                    },
                  ],
                  sourceEventIds: ["checkpoint_explore"],
                }),
              },
            ],
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
    const facts = await readFacts(context.memoryRoot);
    expect(facts[0]?.text).toContain("ero is a Go Bubble Tea TUI");
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toBe("");
  });

  it("skips malformed pending event lines instead of aborting", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      '{not json}\n{"schemaVersion":1,"kind":"bogus","id":"bad","createdAt":"2026-06-07T00:00:00.000Z"}\n',
    );
    const result = await consolidateProjectMemory(context, { hasUI: false });
    expect(result.applied).toBe(0);
    expect(result.pendingConfirmation).toBe(0);
  });

  it("persists confirmation-required removals for headless approval", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await writeFacts(context.memoryRoot, [fact()]);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_remove",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Review stale project facts",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            candidates: [
              {
                action: "remove",
                factId: "fact_one",
                confirmationRequired: false,
                reason: "stale",
              },
            ],
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

    expect(result.mode).toBe("model");
    expect(result.applied).toBe(0);
    expect(result.pendingConfirmation).toBe(1);
    expect(await readFacts(context.memoryRoot)).toHaveLength(1);
    expect(
      await readFile(
        join(context.memoryRoot, "pending-confirmations.jsonl"),
        "utf8",
      ),
    ).toContain("fact_one");
  });

  it("does not mutate facts or clear pending events when output budget is exhausted", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_budget",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    await writeFile(
      join(context.memoryRoot, "usage.json"),
      JSON.stringify({
        days: {
          [new Date().toISOString().slice(0, 10)]: { input: 0, output: 9_999 },
        },
      }),
    );

    await expect(
      consolidateProjectMemory(context, { hasUI: false }),
    ).rejects.toThrow(/output token budget/);
    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).not.toBe("");
  });

  it("no-ops selected consolidation when no requested event is pending", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, buildNoteEvent("backlog", "tool"));
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({ candidates: [{ action: "add" }] }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);
    const fakeModel = { provider: "fake", id: "model" } as never;

    const result = await consolidateProjectMemory(
      context,
      {
        hasUI: false,
        model: fakeModel,
        modelRegistry: {
          find: () => undefined,
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "key" };
          },
        },
      },
      { eventIds: new Set(["missing"]) },
    );

    expect(result.applied).toBe(0);
    expect(result.inputEstimate).toBe(0);
    expect(mockedComplete).not.toHaveBeenCalled();
    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    expect(await pathExists(join(context.memoryRoot, "update-log.jsonl"))).toBe(
      false,
    );
  });

  it("can consolidate only selected pending events", async ({ task }) => {
    const { context } = await createRepo(task.id);
    const oldEvent = buildNoteEvent("old backlog note", "tool");
    const currentEvent = buildNoteEvent("current automatic note", "tool");
    await appendPendingEvent(context, oldEvent);
    await appendPendingEvent(context, currentEvent);

    const result = await consolidateProjectMemory(
      context,
      { hasUI: false },
      { eventIds: new Set([currentEvent.id]) },
    );

    expect(result.applied).toBe(1);
    const facts = await readFacts(context.memoryRoot);
    expect(facts.map((item) => item.text)).toEqual(["current automatic note"]);
    const pending = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(pending).toContain(oldEvent.id);
    expect(pending).not.toContain(currentEvent.id);
  });

  it("preserves raw unprocessed pending backlog lines", async ({ task }) => {
    const { context } = await createRepo(task.id);
    const selected = buildNoteEvent("selected note", "tool");
    const rawBacklog = JSON.stringify({
      schemaVersion: 1,
      id: "raw_backlog",
      kind: "note",
      source: "tool",
      createdAt: "2026-06-07T00:00:00.000Z",
      text: "backlog note",
      extraField: "keep me exactly",
    });
    await writeFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      `${rawBacklog}\n{malformed json}\n${JSON.stringify(selected)}\n`,
    );

    await consolidateProjectMemory(
      context,
      { hasUI: false },
      { eventIds: new Set([selected.id]) },
    );

    const pending = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(pending).toContain(rawBacklog);
    expect(pending).toContain("{malformed json}");
    expect(pending).not.toContain(selected.id);
  });

  it("removes only processed pending events", async ({ task }) => {
    const { context } = await createRepo(task.id);
    const processed = {
      schemaVersion: 1 as const,
      id: "checkpoint_processed",
      kind: "checkpoint" as const,
      source: "command" as const,
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    };
    const concurrent = buildNoteEvent("concurrent", "tool");
    await appendPendingEvent(context, processed);
    mockedComplete.mockImplementationOnce(async () => {
      await appendPendingEvent(context, concurrent);
      return {
        role: "assistant",
        timestamp: Date.now(),
        content: [
          {
            type: "text",
            text: JSON.stringify({ candidates: [] }),
          },
        ],
      } as Awaited<ReturnType<typeof complete>>;
    });
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

    const pending = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(pending).not.toContain(processed.id);
    expect(pending).toContain(concurrent.id);
  });

  it("recovers from malformed usage accounting", async ({ task }) => {
    const { context } = await createRepo(task.id);
    await writeFile(join(context.memoryRoot, "usage.json"), "{nope");
    await appendPendingEvent(context, buildNoteEvent("note", "tool"));
    const result = await consolidateProjectMemory(context, { hasUI: false });
    expect(result.applied).toBe(1);
  });

  it("does not call the model when output budget is exhausted", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_output_budget",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    await writeFile(
      join(context.memoryRoot, "usage.json"),
      JSON.stringify({
        days: {
          [new Date().toISOString().slice(0, 10)]: { input: 0, output: 10_000 },
        },
      }),
    );
    const fakeModel = { provider: "fake", id: "model" } as never;
    await expect(
      consolidateProjectMemory(context, {
        hasUI: false,
        model: fakeModel,
        modelRegistry: {
          find: () => undefined,
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "key" };
          },
        },
      }),
    ).rejects.toThrow(/output token budget/);
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it("does not send extra pending-event fields to the model", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "checkpoint_extra",
        kind: "checkpoint",
        source: "command",
        createdAt: "2026-06-07T00:00:00.000Z",
        objective: "safe checkpoint",
        commands: [],
        changedFilesStatTruncated: false,
        fallbackNotes: [],
        extraSecret: "SHOULD_NOT_LEAK",
      })}\n`,
    );
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ candidates: [] }) }],
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
    expect(JSON.stringify(mockedComplete.mock.calls[0]?.[1])).not.toContain(
      "SHOULD_NOT_LEAK",
    );
  });

  it("skips checkpoint consolidation when model completion throws", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, {
      schemaVersion: 1,
      id: "checkpoint_throw",
      kind: "checkpoint",
      source: "command",
      createdAt: "2026-06-07T00:00:00.000Z",
      objective: "Explore project architecture",
      changedFilesStatTruncated: false,
      commands: [],
      fallbackNotes: [],
    });
    mockedComplete.mockRejectedValueOnce(new Error("auth revoked"));
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
    expect(result).toMatchObject({
      mode: "skipped",
      reason: "model unavailable",
      applied: 0,
    });
    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
  });
});
