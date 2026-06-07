import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  consolidateProjectMemory,
  fallbackCandidates,
} from "../src/consolidation";
import {
  appendPendingEvent,
  buildCheckpointEvent,
  buildNoteEvent,
} from "../src/events";
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
  it("builds broad fallback candidates from notes and checkpoint commands", async ({
    task,
  }) => {
    const { repo } = await createRepo(task.id);
    const checkpoint = await buildCheckpointEvent(
      repo,
      {
        sessionManager: {
          getBranch: () => [
            { message: { role: "bashExecution", command: "npm test" } },
          ],
        },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    const candidates = fallbackCandidates([
      buildNoteEvent("Architecture uses adapters", "tool"),
      checkpoint,
    ]);
    expect(candidates.map((candidate) => candidate.fact?.kind)).toEqual([
      "observation",
      "command",
    ]);
    expect(candidates.map((candidate) => candidate.fact?.topic)).toEqual([
      "other",
      "tooling",
    ]);
  });

  it("fallback consolidation writes facts and generated artifacts without model auth", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(
      context,
      buildNoteEvent("Remember token=secret project fact", "tool"),
    );
    const result = await consolidateProjectMemory(context, { hasUI: false });

    expect(result.mode).toBe("fallback");
    expect(result.applied).toBe(1);
    const facts = await readFacts(context.memoryRoot);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.text).not.toContain("secret");
    expect(await pathExists(join(context.memoryRoot, "MEMORY.md"))).toBe(true);
    expect(
      await pathExists(join(context.memoryRoot, "memory_summary.md")),
    ).toBe(true);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toBe("");
  });

  it("falls back without calling a model when auth is unavailable", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, buildNoteEvent("note", "tool"));
    const fakeModel = { provider: "fake", id: "model" } as never;
    const result = await consolidateProjectMemory(context, {
      hasUI: false,
      model: fakeModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true };
        },
      },
    });
    expect(result.mode).toBe("fallback");
    expect(mockedComplete).not.toHaveBeenCalled();
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
    await appendPendingEvent(
      context,
      buildNoteEvent("remove stale fact", "tool"),
    );
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
    await appendPendingEvent(context, buildNoteEvent("budget test", "tool"));
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

  it("removes only processed pending events", async ({ task }) => {
    const { context } = await createRepo(task.id);
    const processed = buildNoteEvent("processed", "tool");
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

  it("falls back when model completion throws", async ({ task }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(context, buildNoteEvent("note", "tool"));
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
    expect(result.mode).toBe("fallback");
    expect(result.applied).toBe(1);
  });
});
