import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  extractStage1Memory,
  isDurableKnowledge,
  persistStage1Output,
  type Stage1Output,
} from "../src/stage1";
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({ status: "ok", modelUsed: "test/model" });
    expect(result.output).toMatchObject(validOutput());
    await persistStage1Output(memoryRoot, result.output!, "test/model");
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
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(mockedComplete).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ apiKey: "test-api-key" }),
    );
  });

  it("handles JSON in ```json code fences", async ({ task }) => {
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

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

    const result = await extractStage1Memory([evidenceItem()], ctxSubscription);

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

    const result = await extractStage1Memory([evidenceItem()], ctxHeadersOnly);

    expect(result).toMatchObject({ status: "ok" });
    const opts = mockedComplete.mock.calls[0]?.[2] as any;
    expect(opts?.apiKey).toBeUndefined();
    expect(opts?.headers).toMatchObject({ "x-api-token": "custom-token" });
  });
});

describe("stage1 extraction — no-output success", () => {
  it("returns no-output when all output fields are empty", async () => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "",
            rollout_summary: "",
            rollout_slug: "",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "no-output",
      modelUsed: "test/model",
    });
  });

  it("returns error when rollout_slug is empty but memory fields are not", async () => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Some valid memory content",
            rollout_summary: "A summary",
            rollout_slug: "",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
      modelUsed: "test/model",
    });
  });

  it("returns no-output when raw_memory is empty", async ({ task }) => {
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "no-output",
      modelUsed: "test/model",
    });
  });

  it("returns no-output when rollout_summary is empty", async ({ task }) => {
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({ status: "no-output" });
  });

  it("treats whitespace-only strings as empty", async ({ task }) => {
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({ status: "no-output" });
  });
});

describe("stage1 extraction — invalid model output", () => {
  it("returns error when model returns unparseable text", async ({ task }) => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: "this is not json" }],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
      modelUsed: "test/model",
    });
  });

  it("returns error when model returns partial JSON", async ({ task }) => {
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
    });
  });

  it("returns error when model types are wrong (non-string fields)", async ({
    task,
  }) => {
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

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "error",
      error: "model produced invalid output",
    });
  });

  it("returns error when model completion throws", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    mockedComplete.mockRejectedValueOnce(new Error("network error"));

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "error",
      error: "model completion failed",
    });
  });
});

describe("stage1 extraction — no model registry / no model", () => {
  it("returns error when modelRegistry is missing", async ({ task }) => {
    const result = await extractStage1Memory([evidenceItem()], {});

    expect(result).toMatchObject({
      status: "error",
      error: "no model registry",
    });
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it("returns error when no model is available", async ({ task }) => {
    const result = await extractStage1Memory([evidenceItem()], {
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
    const result = await extractStage1Memory([evidenceItem()], {
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

    const result = await extractStage1Memory([], ctxNoAuth);

    // Empty evidence → model should return no-output
    expect(result).toMatchObject({ status: "no-output" });
  });

  it("truncates oversized evidence", async ({ task }) => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const hugeEvidence = [evidenceItem({ content: "x".repeat(100_000) })];

    const result = await extractStage1Memory(hugeEvidence, ctxNoAuth);

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
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [{ type: "text", text: JSON.stringify(validOutput()) }],
    } as Awaited<ReturnType<typeof complete>>);

    const activeModel = testModel("acme", "v1");
    const defaultModel = testModel("google", "gemini-2.5-flash");

    let callCount = 0;
    const result = await extractStage1Memory([evidenceItem()], {
      model: activeModel,
      modelRegistry: {
        find: () => defaultModel,
        async getApiKeyAndHeaders(model: Model<Api>) {
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

describe("stage1 extraction — quality validation", () => {
  it("isDurableKnowledge rejects transient task-progress language", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "Working on implementing the user authentication flow on the feature/auth branch.",
        rollout_summary: "Authentication task progress",
        rollout_slug: "auth-task-progress",
      }),
    ).toBe(false);
  });

  it("isDurableKnowledge accepts durable guidance mentioning future work", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "When working on the API layer, keep request validation in shared middleware.",
        rollout_summary: "API validation convention",
        rollout_slug: "api-validation-convention",
      }),
    ).toBe(true);
  });

  it("isDurableKnowledge rejects agent-process narrative", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "The agent looked at the codebase, ran npm test, found 3 failing tests, fixed them, and committed the changes.",
        rollout_summary: "Fix failing tests in CI pipeline",
        rollout_slug: "fix-ci-tests",
      }),
    ).toBe(false);
  });

  it("isDurableKnowledge accepts architectural agent terminology", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "The background agent pattern is used to serialize long-running sync jobs.",
        rollout_summary: "Background agent architecture",
        rollout_slug: "background-agent-architecture",
      }),
    ).toBe(true);
  });

  it("isDurableKnowledge rejects session-scoped output", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "This session explored the project architecture and found routes under src/routes.",
        rollout_summary: "Session architecture exploration",
        rollout_slug: "session-arch",
      }),
    ).toBe(false);
  });

  it("isDurableKnowledge rejects branch-specific references", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "On the feature/rate-limiting branch, the agent set up rate limiting middleware and configured limits.",
        rollout_summary: "Rate limiting branch work",
        rollout_slug: "rate-limit-branch",
      }),
    ).toBe(false);
  });

  it("isDurableKnowledge accepts architecture facts", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "Routes follow Express middleware pattern. Authentication is handled by a dedicated middleware module at src/middleware/auth.ts.",
        rollout_summary: "Routes and auth convention",
        rollout_slug: "routes-auth-convention",
      }),
    ).toBe(true);
  });

  it("isDurableKnowledge accepts command conventions", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "Run `npm test` before committing. Use Biome for linting via `npm run lint`.",
        rollout_summary: "Development commands",
        rollout_slug: "dev-commands",
      }),
    ).toBe(true);
  });

  it("isDurableKnowledge accepts project structure notes", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "Project uses npm workspaces with packages in packages/ directory. Each package has its own tsconfig.json.",
        rollout_summary: "Project structure",
        rollout_slug: "project-structure",
      }),
    ).toBe(true);
  });

  it("isDurableKnowledge accepts known-issue landmine notes", () => {
    expect(
      isDurableKnowledge({
        raw_memory:
          "Avoid using `nock` in tests—it has compatibility issues with the fetch API. Use `msw` instead.",
        rollout_summary: "Testing landmine: nock vs msw",
        rollout_slug: "testing-msw-over-nock",
      }),
    ).toBe(true);
  });

  it("extractStage1Memory rejects transient output as rejected-low-quality", async ({
    task,
  }) => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory:
              "Working on the task to implement the user authentication flow on the feature/auth branch. The agent set up routes and middleware.",
            rollout_summary: "Authentication task progress",
            rollout_slug: "auth-task-progress",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "rejected-low-quality",
      modelUsed: "test/model",
    });
    expect(result.output).toBeDefined();
  });

  it("extractStage1Memory rejects agent-process-focused output", async ({
    task,
  }) => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory:
              "The agent looked at the codebase, ran npm test, found 3 failing tests, fixed them, and committed the changes.",
            rollout_summary: "Fix failing tests in CI pipeline",
            rollout_slug: "fix-ci-tests",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "rejected-low-quality",
      modelUsed: "test/model",
    });
  });

  it("extractStage1Memory accepts durable architecture knowledge", async ({
    task,
  }) => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory:
              "Routes follow Express middleware pattern. Authentication is handled by a dedicated middleware module at src/middleware/auth.ts.",
            rollout_summary: "Routes and auth convention",
            rollout_slug: "routes-auth-convention",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "ok",
      modelUsed: "test/model",
    });
  });

  it("extractStage1Memory accepts command convention knowledge", async ({
    task,
  }) => {
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory:
              "Run `npm test` before committing. Use Biome for linting via `npm run lint`.",
            rollout_summary: "Development commands",
            rollout_slug: "dev-commands",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    const result = await extractStage1Memory([evidenceItem()], ctxNoAuth);

    expect(result).toMatchObject({
      status: "ok",
    });
  });
});
