# Project memory Pi API spike

This report documents the Pi APIs that `pi-project-memory` is allowed to rely on. It is based on the local Pi documentation, example extensions, and type declarations inspected during implementation. The manual spike extension lives at `spikes/project-memory-api-spike.ts` and is intentionally not part of the package manifest.

## Package and extension loading

Evidence:

- Pi packages declare resources in `package.json` under the `pi` key and should include the `pi-package` keyword.
- Extension directories are supported when they contain an `index.ts` entrypoint; this package exposes `extensions/index.ts` and delegates to `extensions/project-memory.ts`.
- Extensions export a default factory receiving `ExtensionAPI`.

Decision:

- The package manifest loads `./extensions`.
- The directory has an explicit `index.ts` to avoid ambiguous directory imports.

## Lifecycle hooks and available signals

The extension type declarations expose these hooks used or planned by project memory:

| Hook                 | Use                                       | Reliable fields from docs/types                                                                                  | MVP decision                                                                           |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `session_start`      | Resolve project identity/storage context  | `event.reason`, `event.previousSessionFile`; `ctx.cwd`, `ctx.sessionManager`, `ctx.mode`, `ctx.hasUI`            | Safe to use for read-path project resolution.                                          |
| `before_agent_start` | Inject concise memory summary             | `event.prompt`, `event.images`, `event.systemPrompt`, `event.systemPromptOptions`; can return `{ systemPrompt }` | Safe to use for bounded prompt injection.                                              |
| `tool_call`          | Future cheap event capture                | `event.toolCallId`, `event.toolName`, mutable `event.input`                                                      | Defer automatic capture until manual spike confirms exact safe fields in target modes. |
| `tool_result`        | Future command/test outcome capture       | `event.toolName`, `event.input`, `event.content`, `event.details`, `event.isError`                               | Defer; capture only allowlisted/truncated snippets when implemented.                   |
| `agent_end`          | Future high-signal scoring/update enqueue | `event.messages`                                                                                                 | Defer model consolidation; do not infer transcript availability beyond bounded fields. |
| `session_shutdown`   | Future flush only                         | `event.reason`, optional `targetSessionFile`                                                                     | Never start long model calls here.                                                     |

Fallback rule: if a desired signal is not reliable in TUI/RPC/print modes, the feature must fall back to explicit checkpoint input such as `git diff --stat`, user-approved notes, and manually provided context.

## Prompt injection

Evidence:

- `before_agent_start` can return a modified `systemPrompt`.
- `event.systemPrompt` is the currently chained prompt for this handler.
- `ctx.getSystemPrompt()` reflects chained changes so far but not later handlers.

Decision:

- Append a delimited `Project Memory` block to `event.systemPrompt` only when `memory_summary.md` exists and is non-empty.
- Treat memory as untrusted local data and instruct the agent to verify drift-prone facts.
- Hard-truncate before injection.

## Tools and commands

Evidence:

- `pi.registerTool()` takes a TypeBox `parameters` schema and an async `execute(...)` function returning tool content.
- `pi.registerCommand(name, { description, handler })` registers slash commands.
- Tool outputs must be truncated; Pi exports truncation helpers, but package code can also enforce local byte caps.
- Commands have UI access through `ctx.ui` and can ask confirmation in interactive/RPC modes.

Decision:

- Implement `project_memory_search`, `project_memory_read`, and `project_memory_status` as custom tools in Phase 3.
- Implement one `/project-memory` command with parsed subcommands.
- Use safe relative path resolution, symlink escape checks, and output truncation.

## Extension-side model invocation

Evidence from Pi's `custom-compaction.ts` example:

```ts
import { complete } from "@earendil-works/pi-ai";

const model = ctx.modelRegistry.find("google", "gemini-2.5-flash");
const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
const response = await complete(
  model,
  { messages },
  {
    apiKey: auth.apiKey,
    headers: auth.headers,
    maxTokens: 8192,
    signal,
  },
);
```

Decision:

- Extension-side model invocation is feasible in principle through `ctx.modelRegistry` and `complete(...)`.
- Phase 5 remains gated until the manual spike command `/project-memory-api-spike-model` succeeds in the target runtime and model auth environment.
- If model auth is unavailable, consolidation is deferred or replaced by manual candidate editing.

## Manual spike extension

Run manually when validating automatic capture/consolidation assumptions:

```bash
pi -e ./spikes/project-memory-api-spike.ts
```

Useful checks:

- Submit a prompt and inspect notifications for `session_start`, `before_agent_start`, and `agent_end` shapes.
- Trigger a simple tool call and inspect `tool_call`/`tool_result` shapes.
- Run `/project-memory-api-spike-model` to test extension-side model invocation.

The spike extension logs only bounded shape previews and should not be enabled by the package manifest.

## Current implementation boundary

Phases 1-3 may use verified read-path APIs. Automatic event capture, high-signal scoring, and model consolidation remain deferred behind the spike results and must degrade to explicit checkpoint input when fields are unavailable.
