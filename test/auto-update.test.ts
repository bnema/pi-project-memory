import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { complete } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushCheckpointOnly,
  maybeAutoUpdateProjectMemory,
  readAutoUpdateState,
  scoreAgentEnd,
  setAutoUpdateEnabled,
} from "../src/auto-update";
import { appendPendingEvent, buildNoteEvent } from "../src/events";
import { readFacts } from "../src/facts";
import { resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));

const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-auto-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-auto-store-${process.pid}-${taskId}`,
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

const fakeModel = { provider: "fake", id: "model" } as never;
const modelRegistry = {
  find: () => undefined,
  async getApiKeyAndHeaders() {
    return { ok: true as const, apiKey: "key" };
  },
};

function mockModelFact(
  text = "Project: Astro site. Architecture: routes plus Svelte components.",
): void {
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
              reason: "source-backed project memory",
              fact: {
                schemaVersion: 1,
                id: "fact_auto_memory",
                kind: "observation",
                topic: "architecture",
                scope: "whole_project",
                text,
                evidence: [{ type: "model", note: "test extraction" }],
                confidence: "medium",
                status: "active",
                stalenessTriggers: ["README*", "src/**"],
                sourceEventIds: ["checkpoint_auto"],
                createdAt: "2026-06-07T00:00:00.000Z",
                updatedAt: "2026-06-07T00:00:00.000Z",
              },
            },
          ],
        }),
      },
    ],
  } as Awaited<ReturnType<typeof complete>>);
}

const highSignalEvent = {
  messages: [
    {
      message: {
        role: "assistant",
        content: "Updated files and remember the architecture decision.",
      },
    },
    { message: { role: "bashExecution", command: "npm test" } },
    { message: { role: "bashExecution", command: "npm run typecheck" } },
  ],
};

afterEach(async () => {
  mockedComplete.mockReset();
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("auto update", () => {
  it("scores only high-signal agent_end events", () => {
    expect(
      scoreAgentEnd({
        messages: [{ message: { role: "assistant", content: "ok" } }],
      }),
    ).toMatchObject({
      shouldUpdate: false,
      score: 0,
    });
    expect(scoreAgentEnd(highSignalEvent)).toMatchObject({
      shouldUpdate: true,
      score: 3,
    });
    expect(
      scoreAgentEnd({
        messages: [
          ...highSignalEvent.messages,
          {
            message: {
              toolName: "edit",
              details: { path: "src/file.ts", edits: [] },
            },
          },
        ],
      }),
    ).toMatchObject({ shouldUpdate: true, score: 4 });
    expect(
      scoreAgentEnd({
        messages: [
          {
            message: {
              role: "assistant",
              content:
                "Le sous-agent a terminé. Architecture map: Astro SSR, Svelte components, API routes. Verification commands found.",
            },
          },
        ],
      }),
    ).toMatchObject({ shouldUpdate: false });
    expect(
      scoreAgentEnd({
        messages: [
          {
            message: {
              role: "assistant",
              content:
                "Le sous-agent a terminé l’exploration. Architecture map: Astro SSR. Rapport complet : /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
            },
          },
        ],
      }),
    ).toMatchObject({ shouldUpdate: true });
    expect(
      scoreAgentEnd({
        messages: [
          {
            message: {
              role: "assistant",
              content:
                "[DONE] Codebase exploration complete. Architecture map: Astro SSR. Full report: /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
            },
          },
        ],
      }),
    ).toMatchObject({ shouldUpdate: true });
    expect(
      scoreAgentEnd({
        messages: [
          {
            message: {
              role: "assistant",
              content:
                "[DONE] Security review complete. Risks: auth boundaries. Full report: /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
            },
          },
        ],
      }),
    ).toMatchObject({ shouldUpdate: false });
    expect(
      scoreAgentEnd({
        messages: [
          {
            message: {
              role: "assistant",
              content:
                "[DONE] Security review complete. Codebase risks: auth boundaries. Architecture notes included. Full report: /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
            },
          },
        ],
      }),
    ).toMatchObject({ shouldUpdate: false });
  });

  it("enables auto-update by default for new project memory", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      enabled: true,
    });
  });

  it("keeps malformed auto-update state fail-closed", async ({ task }) => {
    const { context } = await createRepo(task.id);
    await writeFile(join(context.memoryRoot, "auto-update.json"), "not json");
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      enabled: false,
    });
  });

  it("enables and disables persisted auto-update state", async ({ task }) => {
    const { context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      enabled: true,
    });
    await setAutoUpdateEnabled(context, false);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      enabled: false,
    });
  });

  it("skips high-signal updates when explicitly disabled", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, false);
    const decision = await maybeAutoUpdateProjectMemory(highSignalEvent, {
      cwd: repo,
      isIdle: () => true,
    });
    expect(decision.shouldUpdate).toBe(true);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastSkipReason: "disabled",
    });
  });

  it("waits for idle instead of skipping immediately", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    let idle = false;
    mockModelFact();
    const run = maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => idle,
        debounceMs: 20,
        hasUI: false,
        model: fakeModel,
        modelRegistry,
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    idle = true;
    await run;

    expect(await readFacts(context.memoryRoot)).not.toHaveLength(0);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastRunAt: "2026-06-07T00:00:00.000Z",
    });
  });

  it("does not use command-only waitForIdle from event contexts", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const ctx = {
      cwd: repo,
      isIdle: () => false,
      waitForIdle: async () => {
        throw new Error("waitForIdle should not be used from agent_end");
      },
      debounceMs: 0,
      hasUI: false,
      sessionManager: { getBranch: () => highSignalEvent.messages },
    } as Parameters<typeof maybeAutoUpdateProjectMemory>[1] & {
      waitForIdle: () => Promise<void>;
    };

    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      ctx,
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastSkipReason: "not idle after debounce",
    });
  });

  it("leaves existing backlog pending during automatic updates", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const backlog = buildNoteEvent("old backlog note", "tool");
    await appendPendingEvent(context, backlog);
    const branchMessages = [
      {
        message: {
          role: "assistant",
          content:
            "Le sous-agent a terminé l’exploration.\n- Project: Astro site.\n- Architecture map: routes plus Svelte components.\nRapport complet : /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
        },
      },
    ];

    mockModelFact();
    await maybeAutoUpdateProjectMemory(
      { messages: [] },
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        model: fakeModel,
        modelRegistry,
        sessionManager: { getBranch: () => branchMessages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    const pending = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(pending).toContain(backlog.id);
    expect(await readFacts(context.memoryRoot)).toHaveLength(1);
  });

  it("notifies when high-signal automatic memory is skipped because no model is available", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const notices: string[] = [];
    const branchMessages = [
      {
        message: {
          role: "assistant",
          content:
            "[DONE] Codebase exploration complete. What the project does: Astro site. Architecture map: routes plus Svelte components. Full report: /tmp/pi-lazy-subagents/run/output-0.log",
        },
      },
    ];

    await maybeAutoUpdateProjectMemory(
      { messages: [] },
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        ui: {
          confirm: async () => false,
          notify: (message) => notices.push(message),
        },
        sessionManager: { getBranch: () => branchMessages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastRunAt: "2026-06-07T00:00:00.000Z",
    });
    expect(notices).toEqual([
      "Project memory skipped: model unavailable or produced no reliable facts",
    ]);
  });

  it("uses the session branch to detect completed read-only exploration", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const branchMessages = [
      {
        message: {
          role: "assistant",
          content:
            "Le sous-agent a terminé l’exploration.\n- Project: Astro site.\n- Architecture map: routes plus Svelte components.\nVerification commands found. Risks listed. Rapport complet : /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
        },
      },
    ];
    mockModelFact(
      "Project: Astro site. Architecture: routes plus Svelte components.",
    );
    await maybeAutoUpdateProjectMemory(
      { messages: [] },
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        model: fakeModel,
        modelRegistry,
        sessionManager: { getBranch: () => branchMessages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    const facts = await readFacts(context.memoryRoot);
    expect(facts[0]?.text).toContain("Project: Astro site");
    expect(facts[0]?.text).not.toContain("sous-agent");
  });

  it("notifies after successful automatic memory update", async ({ task }) => {
    const { repo } = await createRepo(task.id);
    const notices: string[] = [];
    mockModelFact();
    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        model: fakeModel,
        modelRegistry,
        ui: {
          confirm: async () => false,
          notify: (message) => notices.push(message),
        },
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    expect(notices).toEqual(["Project memory updated"]);
  });

  it("runs consolidation only while idle and preserves min interval", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);
    mockModelFact();
    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        model: fakeModel,
        modelRegistry,
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(await readFacts(context.memoryRoot)).not.toHaveLength(0);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      enabled: true,
      lastRunAt: "2026-06-07T00:00:00.000Z",
    });

    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      { cwd: repo, isIdle: () => true, hasUI: false },
      new Date("2026-06-07T00:01:00.000Z"),
    );
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastSkipReason: "min interval",
    });
  });

  it("preserves pending events when consolidation budget is exhausted", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);
    await writeFile(
      join(context.memoryRoot, "usage.json"),
      JSON.stringify({
        days: {
          [new Date().toISOString().slice(0, 10)]: {
            input: 60_000,
            output: 0,
          },
        },
      }),
    );

    await expect(
      maybeAutoUpdateProjectMemory(
        highSignalEvent,
        {
          cwd: repo,
          isIdle: () => true,
          debounceMs: 0,
          hasUI: false,
          model: fakeModel,
          modelRegistry,
          sessionManager: { getBranch: () => highSignalEvent.messages },
        },
        new Date("2026-06-07T00:00:00.000Z"),
      ),
    ).rejects.toThrow(/input token budget/);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toContain("checkpoint");
  });

  it("does not let unrelated skips clear an active automatic update", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);
    let idle = true;
    const first = maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => idle,
        debounceMs: 50,
        hasUI: false,
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    idle = false;
    await maybeAutoUpdateProjectMemory(highSignalEvent, {
      cwd: repo,
      isIdle: () => false,
      debounceMs: 0,
      hasUI: false,
    });
    idle = true;
    await first;

    const state = await readAutoUpdateState(context.memoryRoot);
    expect(state.lastRunAt).toBe("2026-06-07T00:00:00.000Z");
    expect(state.runningId).toBeUndefined();
  });

  it("cancels automatic updates disabled during model consolidation", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);
    let resolveModel:
      | ((value: Awaited<ReturnType<typeof complete>>) => void)
      | undefined;
    mockedComplete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveModel = resolve;
        }),
    );

    const run = maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        model: { provider: "fake", id: "model" } as never,
        modelRegistry: {
          find: () => undefined,
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "key" };
          },
        },
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    while (!mockedComplete.mock.calls.length) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await setAutoUpdateEnabled(context, false);
    resolveModel?.({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify({ candidates: [] }) }],
    } as Awaited<ReturnType<typeof complete>>);
    await run;

    const state = await readAutoUpdateState(context.memoryRoot);
    expect(state.enabled).toBe(false);
    expect(state.lastRunAt).toBeUndefined();
    expect(state.lastSkipReason).toBe("disabled during update");
    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toContain("checkpoint");
  });

  it("cancels queued automatic updates when disabled", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);
    const run = maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 50,
        hasUI: false,
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await setAutoUpdateEnabled(context, false);
    await run;

    const state = await readAutoUpdateState(context.memoryRoot);
    expect(state.enabled).toBe(false);
    expect(state.lastRunAt).toBeUndefined();
    expect(state.lastSkipReason).toBe("disabled during update");
    await expect(
      readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).rejects.toThrow();
  });

  it("serializes concurrent automatic updates", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, true);

    const first = maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 50,
        hasUI: false,
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        sessionManager: { getBranch: () => highSignalEvent.messages },
      },
      new Date("2026-06-07T00:11:00.000Z"),
    );
    await first;

    const state = await readAutoUpdateState(context.memoryRoot);
    expect(state.lastRunAt).toBe("2026-06-07T00:00:00.000Z");
    expect(state.lastSkipReason).toBe("already running");
  });

  it("skips low-signal shutdown flushes", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const event = await flushCheckpointOnly({ cwd: repo });
    expect(event).toBeUndefined();
    await expect(
      readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).rejects.toThrow();
  });

  it("skips shutdown flushes when pending events are capped", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const events = Array.from({ length: 200 }, (_, index) =>
      JSON.stringify(
        buildNoteEvent(`note ${index}`, "tool", new Date(1_000 + index)),
      ),
    ).join("\n");
    await writeFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      `${events}\n`,
    );

    const event = await flushCheckpointOnly({
      cwd: repo,
      sessionManager: { getBranch: () => highSignalEvent.messages },
    });
    expect(event).toBeUndefined();
  });

  it("flushes a checkpoint on shutdown without consolidation", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await flushCheckpointOnly({
      cwd: repo,
      sessionManager: { getBranch: () => highSignalEvent.messages },
    });
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toContain("checkpoint");
    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
  });
});
