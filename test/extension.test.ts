import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { complete } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import projectMemoryExtension from "../extensions/project-memory";
import { readFacts } from "../src/facts";
import { readAutoUpdateState } from "../src/auto-update";
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

function mockModelFact(
  text = "Project: Go tmux plugin. Architecture: ports/adapters.",
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
                id: "fact_extension_memory",
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

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(
  taskId: string,
  options: { memoryRoot?: string; remoteName?: string } = {},
) {
  const repo = join(
    "/tmp",
    `pi-project-memory-extension-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot =
    options.memoryRoot ??
    join("/tmp", `pi-project-memory-extension-store-${process.pid}-${taskId}`);
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(
    [
      "remote",
      "add",
      "origin",
      `git@github.com:org/${options.remoteName ?? "repo"}.git`,
    ],
    repo,
  );
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

  it("cancels deferred agent_end auto-update on session shutdown", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const handlers = new Map<string, (...args: any[]) => Promise<any> | any>();
    const pi = {
      on(event: string, handler: (...args: any[]) => Promise<any> | any) {
        handlers.set(event, handler);
      },
      registerTool() {},
      registerCommand() {},
    };
    projectMemoryExtension(pi as never);

    await handlers.get("agent_end")?.(
      { messages: [] },
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        ui: { notify: () => undefined },
        sessionManager: {
          getBranch: () => [
            {
              message: {
                role: "assistant",
                content:
                  "Le sous-agent a terminé l’exploration.\n- Project: Go tmux plugin.\n- Architecture map: ports/adapters.\nRapport complet : /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
              },
            },
          ],
        },
      },
    );
    await handlers.get("session_shutdown")?.(
      { reason: "reload" },
      {
        cwd: repo,
        ui: { notify: () => undefined },
        sessionManager: { getBranch: () => [] },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
  });

  it("does not let one project shutdown cancel another project's deferred update", async ({
    task,
  }) => {
    const memoryRoot = join(
      "/tmp",
      `pi-project-memory-extension-store-${process.pid}-${task.id}-shared`,
    );
    const first = await createRepo(`${task.id}-first`, {
      memoryRoot,
      remoteName: "first",
    });
    const second = await createRepo(`${task.id}-second`, {
      memoryRoot,
      remoteName: "second",
    });
    const handlers = new Map<string, (...args: any[]) => Promise<any> | any>();
    const pi = {
      on(event: string, handler: (...args: any[]) => Promise<any> | any) {
        handlers.set(event, handler);
      },
      registerTool() {},
      registerCommand() {},
    };
    projectMemoryExtension(pi as never);

    mockModelFact();
    await handlers.get("agent_end")?.(
      { messages: [] },
      {
        cwd: first.repo,
        isIdle: () => true,
        debounceMs: 0,
        hasUI: false,
        model: fakeModel,
        modelRegistry,
        ui: { notify: () => undefined },
        sessionManager: {
          getBranch: () => [
            {
              message: {
                role: "assistant",
                content:
                  "Le sous-agent a terminé l’exploration. Project: Go tmux plugin. Architecture map: ports/adapters. Rapport complet : /tmp/pi-lazy-subagents/run/output-0.log",
              },
            },
          ],
        },
      },
    );
    await handlers.get("session_shutdown")?.(
      { reason: "reload" },
      {
        cwd: second.repo,
        ui: { notify: () => undefined },
        sessionManager: { getBranch: () => [] },
      },
    );
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if ((await readFacts(first.context.memoryRoot)).length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(await readFacts(first.context.memoryRoot)).toHaveLength(1);
    expect(await readFacts(second.context.memoryRoot)).toHaveLength(0);
  });

  it("aborts same-project deferred auto-updates started from a subdirectory", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const subdir = join(repo, "src", "feature");
    await mkdir(subdir, { recursive: true });
    const handlers = new Map<string, (...args: any[]) => Promise<any> | any>();
    const pi = {
      on(event: string, handler: (...args: any[]) => Promise<any> | any) {
        handlers.set(event, handler);
      },
      registerTool() {},
      registerCommand() {},
    };
    projectMemoryExtension(pi as never);

    await handlers.get("agent_end")?.(
      { messages: [] },
      {
        cwd: subdir,
        isIdle: () => true,
        debounceMs: 50,
        hasUI: false,
        ui: { notify: () => undefined },
        sessionManager: {
          getBranch: () => [
            {
              message: {
                role: "assistant",
                content:
                  "Le sous-agent a terminé l’exploration. Project: Go tmux plugin. Architecture map: ports/adapters. Rapport complet : /tmp/pi-lazy-subagents/run/output-0.log",
              },
            },
          ],
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handlers.get("session_shutdown")?.(
      { reason: "reload" },
      {
        cwd: repo,
        ui: { notify: () => undefined },
        sessionManager: { getBranch: () => [] },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
  });

  it("aborts started deferred auto-updates on session shutdown", async ({
    task,
  }) => {
    const { repo, context } = await createRepo(task.id);
    const handlers = new Map<string, (...args: any[]) => Promise<any> | any>();
    const pi = {
      on(event: string, handler: (...args: any[]) => Promise<any> | any) {
        handlers.set(event, handler);
      },
      registerTool() {},
      registerCommand() {},
    };
    projectMemoryExtension(pi as never);

    await handlers.get("agent_end")?.(
      { messages: [] },
      {
        cwd: repo,
        isIdle: () => true,
        debounceMs: 50,
        hasUI: false,
        ui: { notify: () => undefined },
        sessionManager: {
          getBranch: () => [
            {
              message: {
                role: "assistant",
                content:
                  "Le sous-agent a terminé l’exploration. Project: Go tmux plugin. Architecture map: ports/adapters. Rapport complet : /tmp/pi-lazy-subagents/run/output-0.log",
              },
            },
          ],
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    await handlers.get("session_shutdown")?.(
      { reason: "reload" },
      {
        cwd: repo,
        ui: { notify: () => undefined },
        sessionManager: { getBranch: () => [] },
      },
    );

    expect(await readFacts(context.memoryRoot)).toHaveLength(0);
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
    mockModelFact(
      "Project: Go tmux plugin. Architecture: ports/adapters with core domain logic and internal/app orchestration.",
    );
    const branchMessages = [
      {
        message: {
          role: "assistant",
          content:
            "Le sous-agent a terminé l’exploration.\n- Project: Go tmux plugin.\n- Architecture map: ports/adapters with core domain logic and internal/app orchestration.\nVerification commands found. Risks listed. Rapport complet : /tmp/pi-lazy-subagents-uid-1000/async-runs/run/output-0.log",
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
        model: fakeModel,
        modelRegistry,
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
