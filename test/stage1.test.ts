import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractStage1Memory, type Stage1Output } from "../src/stage1";
import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import type { SessionEvidenceItem } from "../src/evidence";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));

const mockedComplete = vi.mocked(complete);
const rootsToCleanup: string[] = [];

afterEach(async () => {
  mockedComplete.mockReset();
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Minimal SessionEvidenceItem factory. */
function evidenceItem(
  overrides: Partial<SessionEvidenceItem> = {},
): SessionEvidenceItem {
  return {
    type: "assistant",
    content: "Explored project structure and found routes.",
    ...overrides,
  };
}

/** Sample valid model output matching the Stage1Output contract. */
function validOutput(overrides: Partial<Stage1Output> = {}): Stage1Output {
  return {
    raw_memory: "Routes use express pattern with middleware chaining.",
    rollout_summary: "Routes architecture discovery",
    rollout_slug: "routes-architecture",
    ...overrides,
  };
}

/** Create a temp directory to use as a memory root. */
async function createMemoryRoot(taskId: string): Promise<string> {
  const dir = join("/tmp", `pi-stage1-${process.pid}-${taskId}`);
  rootsToCleanup.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function testModel(provider: string, id: string): Model<Api> {
  return { provider, id } as unknown as Model<Api>;
}

/** Shared minimal stage-1 context with a working modelRegistry. */
const ctxNoAuth = {
  model: testModel("test", "model"),
  modelRegistry: {
    find: () => undefined,
    async getApiKeyAndHeaders() {
      return { ok: true, apiKey: "test-api-key" } as const;
    },
  },
};

describe("stage1 extraction — api-key auth path", () => {
  it("extracts memory and persists to stage1-outputs.jsonl", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({ status: "ok", modelUsed: "test/model" });
    expect(result.output).toMatchObject(validOutput());
    expect(mockedComplete).toHaveBeenCalledTimes(1);
    expect(mockedComplete).toHaveBeenCalledWith(
      ctxNoAuth.model,
      expect.objectContaining({ systemPrompt: expect.any(String) }),
      expect.objectContaining({
        apiKey: "test-api-key",
        headers: undefined,
      }),
    );

    // Verify persistence
    const persisted = await readFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      "utf8",
    );
    expect(persisted).toContain("routes-architecture");
    expect(persisted).toContain("Routes architecture discovery");
  });

  it("passes apiKey from modelRegistry to complete()", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    await extractStage1Memory([evidenceItem()], memoryRoot, ctxNoAuth);

    expect(mockedComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: "test-api-key" }),
    );
  });

  it("handles JSON in ```json code fences", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: `Some preamble\n\`\`\`json\n${JSON.stringify(validOutput())}\n\`\`\`\ntrailing`,
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({ status: "ok" });
    expect(result.output?.raw_memory).toBe(
      "Routes use express pattern with middleware chaining.",
    );
  });
});

describe("stage1 extraction — subscription auth path", () => {
  it("uses headers without apiKey for subscription/OAuth models", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const subscriptionModel = testModel("openai-codex", "gpt-5.5");
    const ctxSubscription = {
      model: subscriptionModel,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return {
            ok: true,
            headers: { authorization: "Bearer sub_token_abc" },
          } as const;
        },
      },
    };

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxSubscription,
    );

    expect(result).toMatchObject({ status: "ok" });
    // apiKey must be undefined, headers must carry the token
    expect(mockedComplete).toHaveBeenCalledWith(
      subscriptionModel,
      expect.anything(),
      expect.objectContaining({
        apiKey: undefined,
        headers: { authorization: "Bearer sub_token_abc" },
      }),
    );
  });

  it("does not require apiKey to be set in options", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const ctxHeadersOnly = {
      model: testModel("custom", "model"),
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return {
            ok: true,
            headers: { "x-api-token": "custom-token" },
          } as const;
        },
      },
    };

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxHeadersOnly,
    );

    expect(result).toMatchObject({ status: "ok" });
    const opts = mockedComplete.mock.calls[0]?.[2] as any;
    expect(opts?.apiKey).toBeUndefined();
    expect(opts?.headers).toMatchObject({ "x-api-token": "custom-token" });
  });
});

describe("stage1 extraction — no-output success", () => {
  it("returns no-output when raw_memory is empty", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify(
            validOutput({ raw_memory: "", rollout_slug: "empty-memory" }),
          ),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({
      status: "no-output",
      modelUsed: "test/model",
    });
  });

  it("returns no-output when rollout_summary is empty", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify(
            validOutput({
              rollout_summary: "",
              rollout_slug: "empty-summary",
            }),
          ),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({ status: "no-output" });
  });

  it("treats whitespace-only strings as empty", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify(
            validOutput({
              raw_memory: "   ",
              rollout_summary: "\n\t",
              rollout_slug: "whitespace-only",
            }),
          ),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({ status: "no-output" });
  });

  it("does not persist anything on no-output", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify(
            validOutput({ raw_memory: "", rollout_slug: "no-persist" }),
          ),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    await extractStage1Memory([evidenceItem()], memoryRoot, ctxNoAuth);

    try {
      await readFile(join(memoryRoot, "stage1-outputs.jsonl"), "utf8");
      expect.unreachable("must not create file on no-output");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    }
  });
});

describe("stage1 extraction — invalid model output", () => {
  it("returns error when model returns unparseable text", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: "this is not json" }],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
      modelUsed: "test/model",
    });
  });

  it("returns error when model returns partial JSON", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({ raw_memory: "foo" }), // missing fields
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
    });
  });

  it("returns error when model types are wrong (non-string fields)", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: 42,
            rollout_summary: {},
            rollout_slug: null,
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
    });
  });

  it("returns error when model completion throws", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockRejectedValueOnce(new Error("network error"));

    const result = await extractStage1Memory(
      [evidenceItem()],
      memoryRoot,
      ctxNoAuth,
    );

    expect(result).toMatchObject({
      status: "error",
      error: "model completion failed",
    });
  });
});

describe("stage1 extraction — no model registry / no model", () => {
  it("returns error when modelRegistry is missing", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);

    const result = await extractStage1Memory([evidenceItem()], memoryRoot, {});

    expect(result).toMatchObject({
      status: "error",
      error: "no model registry",
    });
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it("returns error when no model is available", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);

    const result = await extractStage1Memory([evidenceItem()], memoryRoot, {
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: false, error: "no key" } as const;
        },
      },
    });

    expect(result).toMatchObject({
      status: "error",
      error: "no model available",
    });
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it("reports auth failure when all models fail auth", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);

    const result = await extractStage1Memory([evidenceItem()], memoryRoot, {
      model: testModel("test", "m1"),
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: false, error: "no credentials" } as const;
        },
      },
    });

    expect(result).toMatchObject({
      status: "error",
      error: "model auth unavailable",
    });
    expect(mockedComplete).not.toHaveBeenCalled();
  });
});

describe("stage1 extraction — evidence handling", () => {
  it("works with empty evidence array", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify(
            validOutput({
              raw_memory: "",
              rollout_slug: "no-evidence",
            }),
          ),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([], memoryRoot, ctxNoAuth);

    // Empty evidence → model should return no-output
    expect(result).toMatchObject({ status: "no-output" });
  });

  it("truncates oversized evidence", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const hugeEvidence = [evidenceItem({ content: "x".repeat(100_000) })];

    const result = await extractStage1Memory(
      hugeEvidence,
      memoryRoot,
      ctxNoAuth,
    );

    // Should still succeed with truncated input
    expect(result).toMatchObject({ status: "ok" });
    // Verify the call received truncated content (not full 100k)
    const callContext = mockedComplete.mock.calls[0]?.[1] as any;
    const userMsg = callContext?.messages?.[0];
    const textPart =
      userMsg && typeof userMsg.content !== "string"
        ? (userMsg.content[0]?.text ?? "")
        : "";
    expect(textPart.length).toBeLessThan(50_000);
  });
});

describe("stage1 extraction — fallback model selection", () => {
  it("falls back to registry default when active model has no auth", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const activeModel = testModel("acme", "v1");
    const defaultModel = testModel("google", "gemini-2.5-flash");

    let callCount = 0;
    const result = await extractStage1Memory([evidenceItem()], memoryRoot, {
      model: activeModel,
      modelRegistry: {
        find: () => defaultModel,
        async getApiKeyAndHeaders(model) {
          callCount++;
          if (model === activeModel) {
            return { ok: false, error: "no key" } as const;
          }
          return { ok: true, apiKey: "default-key" };
        },
      },
    });

    expect(result).toMatchObject({ status: "ok" });
    expect(mockedComplete).toHaveBeenCalledWith(
      defaultModel,
      expect.anything(),
      expect.objectContaining({ apiKey: "default-key" }),
    );
  });
});
