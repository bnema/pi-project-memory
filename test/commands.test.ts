import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { complete } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleProjectMemoryCommand } from "../src/commands";
import { readAutoUpdateState } from "../src/auto-update";
import { readFacts, writeFacts, type ProjectFact } from "../src/facts";
import { pathExists, resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));

const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

interface Notice {
  message: string;
  level?: "info" | "warning" | "error";
}

function mockContext(cwd: string, hasUI = true, confirmResult = false) {
  const notices: Notice[] = [];
  const confirms: Array<{ title: string; message: string }> = [];
  return {
    ctx: {
      cwd,
      hasUI,
      ui: {
        notify(message: string, level?: "info" | "warning" | "error") {
          notices.push({ message, level });
        },
        async confirm(title: string, message: string) {
          confirms.push({ title, message });
          return confirmResult;
        },
      },
    },
    notices,
    confirms,
  };
}

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
    text: "Fact",
    evidence: [{ type: "user", note: "test" }],
    confidence: "verified",
    status: "possibly_stale",
    stalenessTriggers: [],
    sourceEventIds: ["event_one"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

async function createRepo(taskId: string, initialize = true) {
  const repo = join(
    "/tmp",
    `pi-project-memory-command-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-command-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = initialize ? await resolveMemoryContext(repo) : undefined;
  return { repo, memoryRoot, context };
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

describe("project-memory command", () => {
  it("defaults to status without creating memory", async ({ task }) => {
    const { repo, memoryRoot } = await createRepo(task.id, false);
    const { ctx, notices } = mockContext(repo);

    await handleProjectMemoryCommand("", ctx);

    expect(notices.at(-1)?.message).toContain("Metadata: not initialized");
    expect(await pathExists(memoryRoot)).toBe(false);
  });

  it("opens existing memory", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const { ctx, notices } = mockContext(repo);

    await handleProjectMemoryCommand("open", ctx);

    expect(notices.at(-1)).toEqual({
      message: `Project memory directory: ${context?.memoryRoot}`,
      level: "info",
    });
  });

  it("shows usage for unknown subcommands", async ({ task }) => {
    const { repo } = await createRepo(task.id, false);
    const { ctx, notices } = mockContext(repo);

    await handleProjectMemoryCommand("wat", ctx);

    expect(notices.at(-1)).toEqual({
      message:
        "Usage: /project-memory status | open | reset | checkpoint | update | verify [fact-id...] | enable-auto | disable-auto",
      level: "warning",
    });
  });

  it("enables and disables automatic updates", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const { ctx, notices } = mockContext(repo);

    await handleProjectMemoryCommand("enable-auto", ctx);
    expect(await readAutoUpdateState(context!.memoryRoot)).toMatchObject({
      enabled: true,
    });
    expect(notices.at(-1)?.message).toContain("enabled");

    await handleProjectMemoryCommand("disable-auto", ctx);
    expect(await readAutoUpdateState(context!.memoryRoot)).toMatchObject({
      enabled: false,
    });
    expect(notices.at(-1)?.message).toContain("disabled");
  });

  it("verifies stale facts", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const { ctx, notices } = mockContext(repo);
    await writeFacts(context!.memoryRoot, [fact()]);

    await handleProjectMemoryCommand("verify", ctx);

    expect(notices.at(-1)?.message).toContain("verified 1 facts");
    expect((await readFacts(context!.memoryRoot))[0]?.status).toBe("active");
  });

  it("captures checkpoint and consolidates update", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const { ctx, notices } = mockContext(repo);
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
                reason: "verified command from checkpoint",
                fact: {
                  schemaVersion: 1,
                  id: "fact_npm_test",
                  kind: "command",
                  topic: "tooling",
                  scope: "whole_project",
                  text: "Verified command observed: npm test",
                  evidence: [{ type: "model", note: "test extraction" }],
                  confidence: "verified",
                  status: "active",
                  stalenessTriggers: ["package.json"],
                  sourceEventIds: ["checkpoint"],
                  createdAt: "2026-06-07T00:00:00.000Z",
                  updatedAt: "2026-06-07T00:00:00.000Z",
                },
              },
            ],
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);
    Object.assign(ctx, {
      model: { provider: "fake", id: "model" },
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
      sessionManager: {
        getBranch: () => [
          {
            message: {
              role: "user",
              content: [{ type: "text", text: "Remember commands" }],
            },
          },
          { message: { role: "bashExecution", command: "npm test" } },
        ],
      },
    });

    await handleProjectMemoryCommand("update", ctx);

    expect(notices.at(-1)?.message).toContain("Project memory update complete");
    expect(
      await readFile(join(context!.memoryRoot, "facts.jsonl"), "utf8"),
    ).toContain("npm test");
    expect(
      await readFile(join(context!.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toBe("");
  });

  it("fails closed for reset without UI", async ({ task }) => {
    const { repo } = await createRepo(task.id);
    const { ctx, notices, confirms } = mockContext(repo, false);

    await handleProjectMemoryCommand("reset", ctx);

    expect(confirms).toHaveLength(0);
    expect(notices.at(-1)?.message).toContain(
      "requires interactive confirmation",
    );
  });

  it("cancels reset when confirmation is declined", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const { ctx, notices, confirms } = mockContext(repo, true, false);

    await handleProjectMemoryCommand("reset", ctx);

    expect(confirms).toHaveLength(1);
    expect(notices.at(-1)?.message).toContain("cancelled");
    expect(await pathExists(context!.memoryRoot)).toBe(true);
  });

  it("deletes memory when reset is confirmed", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    const { ctx, notices } = mockContext(repo, true, true);

    await handleProjectMemoryCommand("reset", ctx);

    expect(notices.at(-1)?.message).toContain("complete");
    expect(await pathExists(context!.memoryRoot)).toBe(false);
  });
});
