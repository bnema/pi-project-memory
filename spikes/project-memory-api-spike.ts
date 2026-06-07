import { complete } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function summarizeShape(value: unknown, depth = 0): unknown {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (value instanceof AbortSignal)
    return { type: "AbortSignal", aborted: value.aborted };

  if (typeof value === "string")
    return { type: "string", length: value.length };
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return { type: typeof value };
  }
  if (typeof value === "function")
    return { type: "function", nameLength: value.name.length };
  if (typeof value !== "object") return { type: typeof value };

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      sampleShape:
        depth < 2 && value.length > 0
          ? summarizeShape(value[0], depth + 1)
          : undefined,
    };
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (depth >= 2) return { type: "object", keys };

  return {
    type: "object",
    keys,
    fields: Object.fromEntries(
      keys.map((key) => [key, summarizeShape(record[key], depth + 1)]),
    ),
  };
}

function notifyShape(
  ctx: {
    ui: { notify(message: string, level?: "info" | "warning" | "error"): void };
  },
  label: string,
  value: unknown,
) {
  const serialized = JSON.stringify(summarizeShape(value), null, 2);
  ctx.ui.notify(`${label}: ${serialized.slice(0, 1200)}`, "info");
}

/**
 * Manual feasibility spike for project-memory API discovery.
 *
 * Run only when validating future capture/consolidation work:
 *   pi -e ./spikes/project-memory-api-spike.ts
 *
 * This extension intentionally does not participate in the package manifest.
 */
export default function projectMemoryApiSpike(pi: ExtensionAPI): void {
  pi.on("session_start", (event, ctx) => {
    notifyShape(ctx, "session_start", {
      event,
      cwd: ctx.cwd,
      mode: ctx.mode,
      hasUI: ctx.hasUI,
      sessionFile: ctx.sessionManager.getSessionFile(),
      branchEntryCount: ctx.sessionManager.getBranch().length,
    });
  });

  pi.on("before_agent_start", (event, ctx) => {
    notifyShape(ctx, "before_agent_start", {
      prompt: event.prompt,
      imageCount: event.images?.length ?? 0,
      systemPromptLength: event.systemPrompt.length,
      selectedTools: event.systemPromptOptions.selectedTools,
      cwd: event.systemPromptOptions.cwd,
      contextFileCount: event.systemPromptOptions.contextFiles?.length ?? 0,
      skillNames: event.systemPromptOptions.skills?.map((skill) => skill.name),
      ctxSystemPromptLength: ctx.getSystemPrompt().length,
    });
  });

  pi.on("tool_call", (event, ctx) => {
    notifyShape(ctx, "tool_call", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
  });

  pi.on("tool_result", (event, ctx) => {
    notifyShape(ctx, "tool_result", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      isError: event.isError,
      contentPreview: event.content,
      detailKeys:
        event.details && typeof event.details === "object"
          ? Object.keys(event.details)
          : undefined,
    });
  });

  pi.on("agent_end", (event, ctx) => {
    notifyShape(ctx, "agent_end", {
      messageCount: event.messages.length,
      roles: event.messages.map((message) => message.role),
    });
  });

  pi.on("session_shutdown", (event, ctx) => {
    notifyShape(ctx, "session_shutdown", event);
  });

  pi.registerCommand("project-memory-api-spike-model", {
    description:
      "Run a minimal extension-side model invocation smoke test for project-memory.",
    handler: async (_args, ctx) => {
      const model =
        ctx.modelRegistry.find("google", "gemini-2.5-flash") ?? ctx.model;
      if (!model) {
        ctx.ui.notify(
          "No active model is available for model smoke test",
          "warning",
        );
        return;
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        ctx.ui.notify(
          `Model auth unavailable for ${model.provider}/${model.id}: ${auth.ok ? "missing API key" : auth.error}`,
          "warning",
        );
        return;
      }

      const response = await complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Reply with exactly: project-memory model smoke ok",
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 32,
        },
      );

      const text = response.content
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");
      ctx.ui.notify(`Model smoke response: ${text}`, "info");
    },
  });
}
