import { rm } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setAutoUpdateEnabled } from "./auto-update";
import { consolidateProjectMemory } from "./consolidation";
import { readFacts, writeFacts, writeMemoryArtifacts } from "./facts";
import { appendPendingEvent, buildCheckpointEvent } from "./events";
import {
  resolveExistingMemoryContext,
  resolveMemoryContext,
  withMemoryLock,
} from "./storage";
import { markStaleFromGit, verifyFacts } from "./staleness";
import { memoryStatus } from "./tools";

interface ProjectMemoryCommandContext {
  cwd: string;
  hasUI: boolean;
  sessionManager?: {
    getBranch?: () => unknown[];
  };
  ui: {
    notify(message: string, level?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
  };
}

function firstArg(args: string): string {
  return args.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

function restArgs(args: string): string[] {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  return parts.slice(1);
}

export async function handleProjectMemoryCommand(
  args: string,
  ctx: ProjectMemoryCommandContext,
): Promise<void> {
  const subcommand = firstArg(args) || "status";

  if (subcommand === "status") {
    ctx.ui.notify(await memoryStatus(ctx.cwd), "info");
    return;
  }

  if (subcommand === "checkpoint" || subcommand === "update") {
    const memoryContext = await resolveMemoryContext(ctx.cwd);
    if (!memoryContext) {
      ctx.ui.notify("No Git repository found for project memory.", "warning");
      return;
    }
    await markStaleFromGit(memoryContext, ctx.cwd);
    const event = await buildCheckpointEvent(ctx.cwd, ctx);
    await appendPendingEvent(memoryContext, event);
    if (subcommand === "checkpoint") {
      ctx.ui.notify(
        `Project memory checkpoint captured pending event: ${event.id}`,
        "info",
      );
      return;
    }

    const result = await consolidateProjectMemory(memoryContext, ctx);
    ctx.ui.notify(
      `Project memory update complete: ${result.applied} applied, ${result.pendingConfirmation} pending confirmation (${result.mode}).`,
      "info",
    );
    return;
  }

  if (subcommand === "verify") {
    const memoryContext = await resolveExistingMemoryContext(ctx.cwd);
    if (!memoryContext) {
      ctx.ui.notify("No existing project memory found.", "warning");
      return;
    }
    const result = await withMemoryLock(
      memoryContext.memoryRoot,
      "facts.lock",
      async () => {
        const facts = await readFacts(memoryContext.memoryRoot);
        const verified = verifyFacts(facts, restArgs(args));
        await writeFacts(memoryContext.memoryRoot, verified.facts);
        await writeMemoryArtifacts(memoryContext.memoryRoot, verified.facts);
        return verified;
      },
    );
    ctx.ui.notify(`Project memory verified ${result.verified} facts.`, "info");
    return;
  }

  if (subcommand === "enable-auto" || subcommand === "disable-auto") {
    const memoryContext = await resolveMemoryContext(ctx.cwd);
    if (!memoryContext) {
      ctx.ui.notify("No Git repository found for project memory.", "warning");
      return;
    }
    const enabled = subcommand === "enable-auto";
    await setAutoUpdateEnabled(memoryContext, enabled);
    ctx.ui.notify(
      `Project memory automatic updates ${enabled ? "enabled" : "disabled"}.`,
      "info",
    );
    return;
  }

  if (subcommand !== "open" && subcommand !== "reset") {
    ctx.ui.notify(
      "Usage: /project-memory status | open | reset | checkpoint | update | verify [fact-id...] | enable-auto | disable-auto",
      "warning",
    );
    return;
  }

  const memoryContext = await resolveExistingMemoryContext(ctx.cwd);
  if (!memoryContext) {
    ctx.ui.notify("No existing project memory found.", "warning");
    return;
  }

  if (subcommand === "open") {
    ctx.ui.notify(
      `Project memory directory: ${memoryContext.memoryRoot}`,
      "info",
    );
    return;
  }

  if (subcommand === "reset") {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Project memory reset requires interactive confirmation.",
        "warning",
      );
      return;
    }
    const confirmed = await ctx.ui.confirm(
      "Reset project memory?",
      `Delete project memory at:\n${memoryContext.memoryRoot}\n\nThis cannot be undone.`,
    );
    if (!confirmed) {
      ctx.ui.notify("Project memory reset cancelled.", "info");
      return;
    }
    await rm(memoryContext.memoryRoot, { recursive: true, force: true });
    ctx.ui.notify("Project memory reset complete.", "info");
    return;
  }
}

export function registerProjectMemoryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("project-memory", {
    description:
      "Inspect and manage project-scoped local memory: status, open, reset, checkpoint, update, verify, enable-auto, disable-auto",
    getArgumentCompletions: (prefix) => {
      const commands = [
        "status",
        "open",
        "reset",
        "checkpoint",
        "update",
        "verify",
        "enable-auto",
        "disable-auto",
      ];
      const filtered = commands.filter((command) =>
        command.startsWith(prefix.trim().toLowerCase()),
      );
      return filtered.length > 0
        ? filtered.map((command) => ({ value: command, label: command }))
        : null;
    },
    handler: handleProjectMemoryCommand,
  });
}
