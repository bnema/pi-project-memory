import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai";
import projectMemoryExtension from "../extensions/project-memory";
import { readAutoUpdateState } from "../src/auto-update";
import { resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));
const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
async function createRepo(taskId: string) {
  const repo = join("/tmp", `pm-extension-repo-${process.pid}-${taskId}`);
  const memoryRoot = join(
    "/tmp",
    `pm-extension-store-${process.pid}-${taskId}`,
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

function fakePi() {
  const handlers = new Map<string, Function>();
  const commands: Record<string, unknown> = {};
  const tools: Record<string, unknown> = {};
  return {
    handlers,
    commands,
    tools,
    on: (name: string, fn: Function) => handlers.set(name, fn),
    registerCommand: (name: string, def: unknown) => {
      commands[name] = def;
    },
    registerTool: (def: { name: string }) => {
      tools[def.name] = def;
    },
  };
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

describe("project memory extension cutover", () => {
  it("registers tools/command and injects artifact summary", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const now = new Date().toISOString();
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      `<!-- memory-summary-schema:1 generated-at:${now} records:1 notes:0 -->\n\n- Known </project_memory_summary> memory`,
    );
    const pi = fakePi();
    projectMemoryExtension(pi as never);

    expect(pi.commands).toHaveProperty("project-memory");
    expect(pi.tools).toHaveProperty("project_memory_read");
    const result = await pi.handlers.get("before_agent_start")!(
      { systemPrompt: "base", systemPromptOptions: { cwd: repo } },
      { ui: { notify: vi.fn() } },
    );
    expect(result.systemPrompt).toContain("&lt;/project_memory_summary&gt;");
  });

  it("skips injection when memory_summary.md has no schema marker (old format)", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      "## Memory Index\nOld format summary without schema marker.",
    );
    const notify = vi.fn();
    const pi = fakePi();
    projectMemoryExtension(pi as never);

    const result = await pi.handlers.get("before_agent_start")!(
      { systemPrompt: "base", systemPromptOptions: { cwd: repo } },
      { ui: { notify } },
    );
    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("unrecognized format"),
      "warning",
    );
  });

  it("skips injection when summary schema version is unsupported", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      "<!-- memory-summary-schema:99 generated-at:2026-06-15T12:00:00.000Z records:1 notes:0 -->\n\nUnsupported summary.",
    );
    const notify = vi.fn();
    const pi = fakePi();
    projectMemoryExtension(pi as never);

    const result = await pi.handlers.get("before_agent_start")!(
      { systemPrompt: "base", systemPromptOptions: { cwd: repo } },
      { ui: { notify } },
    );
    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("unsupported schema version"),
      "warning",
    );
  });

  it("skips injection when summary has a future timestamp", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      `<!-- memory-summary-schema:1 generated-at:${futureDate} records:1 notes:0 -->\n\nFuture summary content.`,
    );
    const notify = vi.fn();
    const pi = fakePi();
    projectMemoryExtension(pi as never);

    const result = await pi.handlers.get("before_agent_start")!(
      { systemPrompt: "base", systemPromptOptions: { cwd: repo } },
      { ui: { notify } },
    );
    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("future timestamp"),
      "warning",
    );
  });

  it("skips injection when newer stage1 sources make the summary stale", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const generatedAt = "2026-06-15T12:00:00.000Z";
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      `<!-- memory-summary-schema:1 generated-at:${generatedAt} records:1 notes:0 -->\n\nStale summary content.`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(
      join(context.memoryRoot, "stage1-outputs.jsonl"),
      "{}\n",
      "utf8",
    );
    const notify = vi.fn();
    const pi = fakePi();
    projectMemoryExtension(pi as never);

    const result = await pi.handlers.get("before_agent_start")!(
      { systemPrompt: "base", systemPromptOptions: { cwd: repo } },
      { ui: { notify } },
    );
    expect(result).toBeUndefined();
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("stale"),
      "warning",
    );
  });

  it("deferred agent_end writes stage1 artifacts, not facts", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Extension captured memory",
            rollout_summary: "Extension memory",
            rollout_slug: "extension-memory",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);
    const pi = fakePi();
    projectMemoryExtension(pi as never);

    pi.handlers.get("agent_end")!(
      {
        messages: [
          { message: { role: "user", content: "Remember architecture" } },
          {
            message: {
              role: "assistant",
              content: "Architecture and testing changed",
            },
          },
          { message: { role: "bashExecution", command: "npm test" } },
          { message: { role: "bashExecution", command: "npm run typecheck" } },
        ],
      },
      {
        cwd: repo,
        model: { provider: "fake", id: "model" },
        modelRegistry: {
          find: () => undefined,
          async getApiKeyAndHeaders() {
            return { ok: true, apiKey: "key" };
          },
        },
        isIdle: () => true,
        ui: { notify: vi.fn(), confirm: async () => false },
      },
    );
    let stage1 = "";
    for (let index = 0; index < 140; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      try {
        stage1 = await readFile(
          join(context.memoryRoot, "stage1-outputs.jsonl"),
          "utf8",
        );
        break;
      } catch {
        // keep waiting for deferred auto-update
      }
    }

    expect(stage1).toContain("extension-memory");

    // Consolidated artifacts regenerated from deferred auto-update
    const memoryMd = await readFile(
      join(context.memoryRoot, "MEMORY.md"),
      "utf8",
    );
    expect(memoryMd).toContain("Extension memory");
    expect(memoryMd).toContain("Extension captured memory");
    expect(memoryMd).toContain("## Durable Memory");
    const summaryMd = await readFile(
      join(context.memoryRoot, "memory_summary.md"),
      "utf8",
    );
    expect(summaryMd).toContain("Extension memory");

    for (let index = 0; index < 80; index += 1) {
      const state = await readAutoUpdateState(context.memoryRoot);
      if (state.lastRunAt && !state.runningId) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await expect(
      readFile(join(context.memoryRoot, "facts.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });
});
