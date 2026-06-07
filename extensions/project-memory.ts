import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  flushCheckpointOnly,
  maybeAutoUpdateProjectMemory,
} from "../src/auto-update";
import { buildProjectMemoryBlock } from "../src/prompts";
import { resolveMemoryContext } from "../src/storage";
import { cleanupMemoryMaintenance, markStaleFromGit } from "../src/staleness";
import { registerProjectMemoryCommand } from "../src/commands";
import { readMemoryFile, registerProjectMemoryTools } from "../src/tools";
import type { ProjectMemoryContext } from "../src/types";

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

type DeferredAutoUpdate = {
  cwd: string;
  controller: AbortController;
  memoryRoot?: string;
  timer?: NodeJS.Timeout;
  promise?: Promise<void>;
};

async function memoryRootForCwd(cwd: string): Promise<string | undefined> {
  try {
    return (await resolveMemoryContext(cwd))?.memoryRoot;
  } catch {
    return undefined;
  }
}

async function isSameDeferredProject(
  job: DeferredAutoUpdate,
  cwd: string,
  memoryRoot: string | undefined,
): Promise<boolean> {
  if (job.cwd === cwd) return true;
  job.memoryRoot ??= await memoryRootForCwd(job.cwd);
  return Boolean(memoryRoot && job.memoryRoot === memoryRoot);
}

export default function projectMemoryExtension(pi: ExtensionAPI): void {
  const deferredAutoUpdates = new Set<DeferredAutoUpdate>();
  pi.on("session_start", async (_event, ctx) => {
    try {
      const memory = await resolveMemoryContext(ctx.cwd);
      if (memory) {
        await markStaleFromGit(memory, ctx.cwd);
        await cleanupMemoryMaintenance(memory.memoryRoot);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Project memory initialization skipped: ${message}`,
        "warning",
      );
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const job: DeferredAutoUpdate = {
      cwd: ctx.cwd,
      controller: new AbortController(),
    };
    job.timer = setTimeout(() => {
      job.timer = undefined;
      job.promise = memoryRootForCwd(ctx.cwd)
        .then((memoryRoot) => {
          job.memoryRoot = memoryRoot;
          if (job.controller.signal.aborted) return undefined;
          return maybeAutoUpdateProjectMemory(event, {
            ...ctx,
            signal: job.controller.signal,
          });
        })
        .then(() => undefined)
        .catch((error) => {
          if (job.controller.signal.aborted) return;
          const message =
            error instanceof Error ? error.message : String(error);
          ctx.ui.notify(
            `Project memory auto-update skipped: ${message}`,
            "warning",
          );
        })
        .finally(() => {
          deferredAutoUpdates.delete(job);
        });
    }, 0);
    deferredAutoUpdates.add(job);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const memoryRoot = await memoryRootForCwd(ctx.cwd);
    const matchingJobs = (
      await Promise.all(
        [...deferredAutoUpdates].map(async (job) =>
          (await isSameDeferredProject(job, ctx.cwd, memoryRoot))
            ? job
            : undefined,
        ),
      )
    ).filter((job): job is DeferredAutoUpdate => Boolean(job));
    for (const job of matchingJobs) {
      if (job.timer) clearTimeout(job.timer);
      job.controller.abort();
      deferredAutoUpdates.delete(job);
    }
    await Promise.allSettled(
      matchingJobs.map((job) => job.promise ?? Promise.resolve()),
    );
    try {
      await flushCheckpointOnly(ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(
        `Project memory shutdown flush skipped: ${message}`,
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
