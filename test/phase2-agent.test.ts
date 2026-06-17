import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { writeMemoryArtifacts } from "../src/memory-artifacts";
import {
  buildPhase2ConsolidationPrompt,
  createPhase2MemoryTools,
  runPhase2ConsolidationAgent,
} from "../src/phase2-agent";

const rootsToCleanup: string[] = [];
const mockSessionPrompt = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    inMemory: vi.fn(() => ({ setRuntimeApiKey: vi.fn() })),
  },
  createAgentSession: vi.fn(async () => ({
    session: {
      prompt: mockSessionPrompt,
      abort: vi.fn(),
      dispose: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      messages: [],
    },
  })),
  DefaultResourceLoader: vi.fn(function DefaultResourceLoader() {
    return { reload: vi.fn(async () => undefined) };
  }),
  defineTool: vi.fn((tool) => tool),
  getAgentDir: vi.fn(() => "/tmp/pi-agent"),
  ModelRegistry: {
    inMemory: vi.fn(() => ({ registerProvider: vi.fn() })),
  },
  SessionManager: {
    inMemory: vi.fn(() => ({})),
  },
  SettingsManager: {
    inMemory: vi.fn(() => ({})),
  },
}));

const piCodingAgent = await import("@earendil-works/pi-coding-agent");

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  return result.content[0]?.text ?? "";
}

async function createMemoryRoot(taskId: string): Promise<string> {
  const dir = join("/tmp", `pi-phase2-agent-${process.pid}-${taskId}`);
  rootsToCleanup.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();
  mockSessionPrompt.mockImplementation(async () => undefined);
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("buildPhase2ConsolidationPrompt", () => {
  it("tells the agent to consolidate memory artifacts and preserve manual notes", () => {
    const prompt = buildPhase2ConsolidationPrompt("/tmp/memory-root");

    expect(prompt).toContain("Phase 2 project-memory consolidation");
    expect(prompt).toContain("raw_memories.md");
    expect(prompt).toContain("rollout_summaries/");
    expect(prompt).toContain("Never delete Manual Notes");
    expect(prompt).toContain("Write only MEMORY.md and memory_summary.md");
  });
});

describe("createPhase2MemoryTools", () => {
  it("exposes only memory_read, memory_write, and memory_list", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const tools = createPhase2MemoryTools(memoryRoot);

    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_read",
      "memory_write",
      "memory_list",
    ]);
  });

  it("rejects reads outside the allowed memory artifact set", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const [readTool] = createPhase2MemoryTools(memoryRoot);

    const result = await readTool.execute(
      "call_1",
      { path: "../stage1-outputs.jsonl" },
      undefined,
      undefined,
      {} as never,
    );

    expect(firstText(result)).toContain("not an allowed memory artifact");
  });

  it("allows writing MEMORY.md but rejects raw_memories.md writes", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const [, writeTool] = createPhase2MemoryTools(memoryRoot);

    const ok = await writeTool.execute(
      "call_1",
      { path: "MEMORY.md", content: "# Project Memory\n" },
      undefined,
      undefined,
      {} as never,
    );
    expect(firstText(ok)).toContain("wrote MEMORY.md");
    expect(await readFile(join(memoryRoot, "MEMORY.md"), "utf8")).toContain(
      "# Project Memory",
    );

    const denied = await writeTool.execute(
      "call_2",
      { path: "raw_memories.md", content: "bad" },
      undefined,
      undefined,
      {} as never,
    );
    expect(firstText(denied)).toContain("read-only");
  });
});

describe("runPhase2ConsolidationAgent", () => {
  it("skips when model or registry is missing", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);

    await expect(
      runPhase2ConsolidationAgent(memoryRoot, {}),
    ).resolves.toMatchObject({ status: "skipped", reason: "no model" });
  });

  it("creates an isolated low-thinking agent session with restricted tools", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(join(memoryRoot, "raw_memories.md"), "# Raw Memories\n");
    await writeFile(join(memoryRoot, "MEMORY.md"), "# Project Memory\n");
    await writeFile(
      join(memoryRoot, "memory_summary.md"),
      `<!-- memory-summary-schema:1 generated-at:${new Date().toISOString()} records:0 rendered-records:0 notes:0 -->\n`,
      "utf8",
    );
    const model = {
      provider: "test",
      id: "model",
      baseUrl: "https://example.test",
      api: "responses",
    } as unknown as Model<any>;

    const result = await runPhase2ConsolidationAgent(memoryRoot, {
      model,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key", headers: { h: "v" } };
        },
      },
    });

    expect(result.status).toBe("ok");
    expect(piCodingAgent.createAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: memoryRoot,
        model,
        thinkingLevel: "low",
        tools: ["memory_read", "memory_write", "memory_list"],
        customTools: expect.arrayContaining([
          expect.objectContaining({ name: "memory_read" }),
          expect.objectContaining({ name: "memory_write" }),
          expect.objectContaining({ name: "memory_list" }),
        ]),
      }),
    );
  });

  it("restores deterministic artifacts when agent writes an invalid summary", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "stage1_routes",
        createdAt: "2026-06-13T12:00:00.000Z",
        result: {
          raw_memory: "Routes use express middleware.",
          rollout_summary: "Routes Architecture",
          rollout_slug: "routes-architecture",
        },
        model: "test/model",
      })}\n`,
      "utf8",
    );
    await writeMemoryArtifacts(memoryRoot);
    mockSessionPrompt.mockImplementationOnce(async () => {
      await writeFile(
        join(memoryRoot, "memory_summary.md"),
        "bad summary",
        "utf8",
      );
    });
    const model = { provider: "test", id: "model" } as unknown as Model<any>;

    const result = await runPhase2ConsolidationAgent(memoryRoot, {
      model,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "memory_summary.md invalid: missing-marker",
    });
    expect(
      await readFile(join(memoryRoot, "memory_summary.md"), "utf8"),
    ).toContain("memory-summary-schema:1");
  });

  it("restores deterministic artifacts when the agent prompt fails", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "stage1_routes",
        createdAt: "2026-06-13T12:00:00.000Z",
        result: {
          raw_memory: "Routes use express middleware.",
          rollout_summary: "Routes Architecture",
          rollout_slug: "routes-architecture",
        },
        model: "test/model",
      })}\n`,
      "utf8",
    );
    await writeMemoryArtifacts(memoryRoot);
    await writeFile(
      join(memoryRoot, "memory_summary.md"),
      "bad summary",
      "utf8",
    );
    mockSessionPrompt.mockRejectedValueOnce(new Error("agent failed"));
    const model = { provider: "test", id: "model" } as unknown as Model<any>;

    const result = await runPhase2ConsolidationAgent(memoryRoot, {
      model,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    expect(result).toEqual({ status: "error", reason: "agent failed" });
    expect(
      await readFile(join(memoryRoot, "memory_summary.md"), "utf8"),
    ).toContain("memory-summary-schema:1");
  });

  it("restores deterministic artifacts when agent removes protected manual notes from memory_summary", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "stage1_routes",
        createdAt: "2026-06-13T12:00:00.000Z",
        result: {
          raw_memory: "Routes use express middleware.",
          rollout_summary: "Routes Architecture",
          rollout_slug: "routes-architecture",
        },
        model: "test/model",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(memoryRoot, "manual-notes.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "manual_note",
        createdAt: "2026-06-13T12:00:00.000Z",
        text: "Protected user-approved note.",
        source: "tool",
      })}\n`,
      "utf8",
    );
    await writeMemoryArtifacts(memoryRoot);
    mockSessionPrompt.mockImplementationOnce(async () => {
      await writeFile(
        join(memoryRoot, "memory_summary.md"),
        `<!-- memory-summary-schema:1 generated-at:${new Date().toISOString()} records:1 rendered-records:1 notes:1 -->\n\n## Memory Index\n\n### Routes Architecture\nRoutes use express middleware.\n`,
        "utf8",
      );
    });
    const model = { provider: "test", id: "model" } as unknown as Model<any>;

    const result = await runPhase2ConsolidationAgent(memoryRoot, {
      model,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "memory_summary.md missing protected manual note",
    });
    expect(
      await readFile(join(memoryRoot, "memory_summary.md"), "utf8"),
    ).toContain("Protected user-approved note.");
  });

  it("restores deterministic artifacts when agent removes protected manual notes", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "stage1_routes",
        createdAt: "2026-06-13T12:00:00.000Z",
        result: {
          raw_memory: "Routes use express middleware.",
          rollout_summary: "Routes Architecture",
          rollout_slug: "routes-architecture",
        },
        model: "test/model",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(memoryRoot, "manual-notes.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "manual_note",
        createdAt: "2026-06-13T12:00:00.000Z",
        text: "Protected user-approved note.",
        source: "tool",
      })}\n`,
      "utf8",
    );
    await writeMemoryArtifacts(memoryRoot);
    mockSessionPrompt.mockImplementationOnce(async () => {
      await writeFile(
        join(memoryRoot, "MEMORY.md"),
        "# Project Memory\n\n## Durable Memory\n\nRoutes use express middleware.\n",
        "utf8",
      );
    });
    const model = { provider: "test", id: "model" } as unknown as Model<any>;

    const result = await runPhase2ConsolidationAgent(memoryRoot, {
      model,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true as const, apiKey: "key" };
        },
      },
    });

    expect(result).toMatchObject({
      status: "error",
      reason: "MEMORY.md missing protected manual note",
    });
    expect(await readFile(join(memoryRoot, "MEMORY.md"), "utf8")).toContain(
      "Protected user-approved note.",
    );
  });
});
