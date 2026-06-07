import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import projectMemoryExtension from "../extensions/project-memory";
import { readFacts } from "../src/facts";
import { readAutoUpdateState } from "../src/auto-update";
import { resolveMemoryContext } from "../src/storage";

const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-extension-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-extension-store-${process.pid}-${taskId}`,
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
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project memory extension", () => {
  it("registers hooks/tools/command and injects escaped summary", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "memory_summary.md"),
      "Known </project_memory_summary> fact",
      "utf8",
    );

    const handlers = new Map<string, (...args: any[]) => Promise<any> | any>();
    const tools: string[] = [];
    const commands: string[] = [];
    const notices: string[] = [];
    const pi = {
      on(event: string, handler: (...args: any[]) => Promise<any> | any) {
        handlers.set(event, handler);
      },
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
    };

    projectMemoryExtension(pi as never);

    expect(tools.sort()).toEqual([
      "project_memory_note",
      "project_memory_read",
      "project_memory_search",
      "project_memory_status",
    ]);
    expect(commands).toEqual(["project-memory"]);

    const ctx = {
      cwd: repo,
      ui: { notify: (message: string) => notices.push(message) },
    };
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const result = await handlers.get("before_agent_start")?.(
      { systemPrompt: "base", systemPromptOptions: { cwd: repo } },
      ctx,
    );

    expect(notices).toEqual([]);
    expect(result.systemPrompt).toContain("## Project Memory");
    expect(result.systemPrompt).toContain("&lt;/project_memory_summary&gt;");
    expect(
      result.systemPrompt.match(/<\/project_memory_summary>/g),
    ).toHaveLength(1);
  });

  it("defers agent_end auto-update until after the hook returns", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const handlers = new Map<string, (...args: any[]) => Promise<any> | any>();
    const notices: string[] = [];
    const pi = {
      on(event: string, handler: (...args: any[]) => Promise<any> | any) {
        handlers.set(event, handler);
      },
      registerTool() {},
      registerCommand() {},
    };
    projectMemoryExtension(pi as never);

    let idle = false;
    const branchMessages = [
      {
        message: {
          role: "assistant",
          content:
            "Le sous-agent a terminé l’exploration. Architecture map: Go ports/adapters. Verification commands found. Risks listed. Rapport complet : /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
        },
      },
    ];
    await handlers.get("agent_end")?.(
      { messages: [] },
      {
        cwd: repo,
        isIdle: () => idle,
        debounceMs: 0,
        hasUI: false,
        ui: { notify: (message: string) => notices.push(message) },
        sessionManager: { getBranch: () => branchMessages },
      },
    );

    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
    idle = true;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const state = await readAutoUpdateState(context.memoryRoot);
      if (state.lastRunAt) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await readFacts(context.memoryRoot)).not.toHaveLength(0);
    expect(await readAutoUpdateState(context.memoryRoot)).toMatchObject({
      lastRunAt: expect.any(String),
    });
    expect(notices).toContain("Project memory updated");
  });
});
