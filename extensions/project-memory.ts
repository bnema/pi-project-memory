import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildProjectMemoryBlock } from "../src/prompts";
import { resolveMemoryContext } from "../src/storage";
import type { ProjectMemoryContext } from "../src/types";
import { registerProjectMemoryCommand } from "../src/commands";
import { registerProjectMemoryTools } from "../src/tools";

async function readSummary(
  memory: ProjectMemoryContext,
): Promise<string | undefined> {
  try {
    return await readFile(join(memory.memoryRoot, "memory_summary.md"), "utf8");
  } catch {
    return undefined;
  }
}

export default function projectMemoryExtension(pi: ExtensionAPI): void {
  const contextsByCwd = new Map<
    string,
    Promise<ProjectMemoryContext | undefined>
  >();
  const getContext = (
    cwd: string,
  ): Promise<ProjectMemoryContext | undefined> => {
    const existing = contextsByCwd.get(cwd);
    if (existing) return existing;
    const created = resolveMemoryContext(cwd).catch(() => undefined);
    contextsByCwd.set(cwd, created);
    return created;
  };

  pi.on("session_start", async (_event, ctx) => {
    await getContext(ctx.cwd);
  });

  pi.on("before_agent_start", async (event) => {
    const cwd = event.systemPromptOptions.cwd;
    const memoryContext = await getContext(cwd);
    if (!memoryContext) return;
    const summary = await readSummary(memoryContext);
    if (!summary?.trim()) return;

    const block = buildProjectMemoryBlock(summary);
    if (!block) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  registerProjectMemoryTools(pi);
  registerProjectMemoryCommand(pi);
}
