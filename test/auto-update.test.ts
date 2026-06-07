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
import { buildNoteEvent } from "../src/events";
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
    ).toMatchObject({ shouldUpdate: true });
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

  it("uses the session branch to detect completed read-only exploration", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const branchMessages = [
      {
        message: {
          role: "assistant",
          content:
            "Le sous-agent a terminé. Architecture map: Astro SSR, Svelte routes. Verification commands found. Risks listed.",
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
        sessionManager: { getBranch: () => branchMessages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    const facts = await readFacts(context.memoryRoot);
    expect(facts[0]?.text).toContain("Le sous-agent a terminé");
  });

  it("notifies after successful automatic memory update", async ({ task }) => {
    const { repo } = await createRepo(task.id);
    const notices: string[] = [];
    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
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
    await maybeAutoUpdateProjectMemory(
      highSignalEvent,
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
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
          [new Date("2026-06-07T00:00:00.000Z").toISOString().slice(0, 10)]: {
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
