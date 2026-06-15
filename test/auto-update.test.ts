import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
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
import { resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));
const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];
const fakeModel = { provider: "fake", id: "model" } as never;
const modelRegistry = {
  find: () => undefined,
  async getApiKeyAndHeaders() {
    return { ok: true as const, apiKey: "key" };
  },
};

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
async function createRepo(taskId: string) {
  const repo = join("/tmp", `pm-auto-repo-${process.pid}-${taskId}`);
  const memoryRoot = join("/tmp", `pm-auto-store-${process.pid}-${taskId}`);
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = await resolveMemoryContext(repo);
  if (!context) throw new Error("expected memory context");
  return { repo, context };
}

function highSignalEvent() {
  return {
    messages: [
      {
        message: {
          role: "user",
          content: "Remember architecture and testing command",
        },
      },
      {
        message: {
          role: "assistant",
          content: "Architecture uses workers. Run npm test.",
        },
      },
      { message: { role: "bashExecution", command: "npm test" } },
      { message: { role: "bashExecution", command: "npm run typecheck" } },
    ],
  };
}

function mockStage1(raw = "Architecture uses workers. Run npm test.") {
  mockedComplete.mockResolvedValueOnce({
    role: "assistant",
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text: JSON.stringify({
          raw_memory: raw,
          rollout_summary: "Auto memory",
          rollout_slug: "auto-memory",
        }),
      },
    ],
  } as Awaited<ReturnType<typeof complete>>);
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

describe("auto update cutover", () => {
  it("scores high-signal sessions", () => {
    const decision = scoreAgentEnd(highSignalEvent());
    expect(decision.shouldUpdate).toBe(true);
  });

  it("writes stage1 output during automatic update", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const notices: string[] = [];
    mockStage1();

    await maybeAutoUpdateProjectMemory(
      highSignalEvent(),
      {
        cwd: repo,
        model: fakeModel,
        modelRegistry,
        isIdle: () => true,
        ui: {
          notify: (message: string) => notices.push(message),
          confirm: async () => false,
        },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(notices).toEqual(["Project memory updated"]);
    expect(
      await readFile(join(context.memoryRoot, "stage1-outputs.jsonl"), "utf8"),
    ).toContain("auto-memory");

    // Consolidated artifacts regenerated from stage1 output
    const memoryMd = await readFile(
      join(context.memoryRoot, "MEMORY.md"),
      "utf8",
    );
    expect(memoryMd).toContain("Auto memory");
    expect(memoryMd).toContain("Architecture uses workers");
    expect(memoryMd).toContain("## Durable Memory");
    const summaryMd = await readFile(
      join(context.memoryRoot, "memory_summary.md"),
      "utf8",
    );
    expect(summaryMd).toContain("Auto memory");

    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastRunAt: "2026-06-07T00:00:00.000Z",
    });
  });

  it("reports skipped extraction without writing facts", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const notices: string[] = [];

    await maybeAutoUpdateProjectMemory(
      highSignalEvent(),
      {
        cwd: repo,
        isIdle: () => true,
        ui: {
          notify: (message: string) => notices.push(message),
          confirm: async () => false,
        },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(notices).toEqual([
      "Project memory skipped: stage1 extraction unavailable or produced no durable memory",
    ]);
    await expect(
      readFile(join(context.memoryRoot, "facts.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);

    // No leftover rendered files from failed extraction
    await expect(
      readFile(join(context.memoryRoot, "MEMORY.md"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("can disable automatic updates and flush checkpoint-only on shutdown", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await setAutoUpdateEnabled(context, false);
    await maybeAutoUpdateProjectMemory(
      highSignalEvent(),
      { cwd: repo, isIdle: () => true },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    await expect(
      readFile(join(context.memoryRoot, "stage1-outputs.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);

    const event = await flushCheckpointOnly(
      {
        cwd: repo,
        sessionManager: { getBranch: () => highSignalEvent().messages },
      },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    expect(event?.kind).toBe("evidence");
    expect(
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8"),
    ).toContain(event!.id);
  });
});
