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
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      "- Known </project_memory_summary> memory",
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
