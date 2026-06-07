import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildProjectMemoryBlock } from "../src/prompts";
import { resolveMemoryContext } from "../src/storage";
import { registerProjectMemoryCommand } from "../src/commands";
import { readMemoryFile, registerProjectMemoryTools } from "../src/tools";
import type { ProjectMemoryContext } from "../src/types";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export default function projectMemoryExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    try {
      await resolveMemoryContext(ctx.cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Project memory initialization skipped: ${message}`,
        "warning",
      );
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = event.systemPromptOptions.cwd;
    let memoryContext: ProjectMemoryContext | undefined;
    try {
      memoryContext = await resolveMemoryContext(cwd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Project memory injection skipped: ${message}`, "warning");
      return;
    }
    if (!memoryContext) return;

    let summary: string | undefined;
    try {
      summary = (await readMemoryFile(cwd, "memory_summary.md")).text;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Project memory summary read skipped: ${message}`,
        "warning",
      );
      return;
    }
    if (!summary.trim()) return;

    const block = buildProjectMemoryBlock(summary);
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  registerProjectMemoryTools(pi);
  registerProjectMemoryCommand(pi);
}
