import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import {
  appendPendingEvent,
  buildCheckpointEvent,
  countPendingEvents,
  type PendingEvent,
} from "./events";
import {
  consolidateProjectMemory,
  type ConsolidationContext,
} from "./consolidation";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  pathExists,
  resolveMemoryContext,
  withMemoryLock,
} from "./storage";
import type { ProjectMemoryContext } from "./types";

const AUTO_STATE_FILE = "auto-update.json";
const AUTO_UPDATE_LOG_FILE = "auto-update-log.jsonl";
const PENDING_EVENTS_FILE = "pending-events.jsonl";
const MIN_INTERVAL_MS = 10 * 60 * 1000;
const DEBOUNCE_MS = 2_000;
const HIGH_SIGNAL_THRESHOLD = 3;
const MAX_PENDING_EVENTS_BEFORE_SHUTDOWN_FLUSH = 200;
const activeRuns = new Map<string, Map<string, AbortController>>();

export interface AutoUpdateState {
  schemaVersion: 1;
  enabled: boolean;
  lastRunAt?: string;
  queuedAt?: string;
  runningId?: string;
  runningAt?: string;
  lastSkipReason?: string;
}

export interface AgentEndLike {
  messages?: unknown[];
}

export interface AutoUpdateContext extends ConsolidationContext {
  cwd: string;
  isIdle?: () => boolean;
  debounceMs?: number;
  sessionManager?: {
    getBranch?: () => unknown[];
  };
}

export interface AutoUpdateDecision {
  shouldUpdate: boolean;
  score: number;
  reasons: string[];
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof (part as { text?: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .join("\n");
}

function toolNameFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const toolName = (message as { toolName?: unknown }).toolName;
  return typeof toolName === "string" ? toolName : undefined;
}

function commandFromMessage(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  if (role === "bashExecution") {
    const command = (message as { command?: unknown }).command;
    return typeof command === "string" ? command : undefined;
  }
  const toolName = toolNameFromMessage(message);
  const details = (message as { details?: unknown }).details;
  if (toolName === "bash" && details && typeof details === "object") {
    const command = (details as { command?: unknown }).command;
    return typeof command === "string" ? command : undefined;
  }
  return undefined;
}

function hasStructuralFileChange(message: unknown): boolean {
  if (!message || typeof message !== "object") return false;
  const toolName = toolNameFromMessage(message);
  if (toolName && /(^|\.)(edit|write)$/.test(toolName)) return true;
  const recipient = (message as { recipient_name?: unknown }).recipient_name;
  if (typeof recipient === "string" && /(^|\.)(edit|write)$/.test(recipient))
    return true;
  const details = (message as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const path = (details as { path?: unknown }).path;
    const edits = (details as { edits?: unknown }).edits;
    const content = (details as { content?: unknown }).content;
    return (
      typeof path === "string" &&
      (Array.isArray(edits) || typeof content === "string")
    );
  }
  return false;
}

function messagesFromAgentEnd(event: AgentEndLike): unknown[] {
  return event.messages ?? [];
}

export function scoreAgentEnd(event: AgentEndLike): AutoUpdateDecision {
  const messages = messagesFromAgentEnd(event);
  const reasons: string[] = [];
  let score = 0;
  let commandCount = 0;
  let wroteFiles = false;
  let verified = false;
  let memoryLanguage = false;

  for (const entry of messages) {
    const message =
      entry && typeof entry === "object" && "message" in entry
        ? (entry as { message?: unknown }).message
        : entry;
    const command = commandFromMessage(message);
    if (command) {
      commandCount += 1;
      if (
        /\b(test|vitest|jest|playwright|tsc|typecheck|check|clippy|audit)\b/i.test(
          command,
        )
      )
        verified = true;
    }
    const text = messageText(message).toLowerCase();
    if (hasStructuralFileChange(message)) wroteFiles = true;
    if (
      /\b(remember|memory|convention|decision|architecture|checkpoint)\b/.test(
        text,
      )
    )
      memoryLanguage = true;
  }

  if (commandCount >= 2) {
    score += 1;
    reasons.push("multiple commands");
  }
  if (wroteFiles) {
    score += 1;
    reasons.push("file change tool evidence");
  }
  if (verified) {
    score += 1;
    reasons.push("verification command");
  }
  if (memoryLanguage) {
    score += 1;
    reasons.push("memory-relevant language");
  }

  return { shouldUpdate: score >= HIGH_SIGNAL_THRESHOLD, score, reasons };
}

function defaultState(): AutoUpdateState {
  return { schemaVersion: 1, enabled: false };
}

export async function readAutoUpdateState(
  memoryRoot: string,
): Promise<AutoUpdateState> {
  const path = await assertInsideMemoryRoot(memoryRoot, AUTO_STATE_FILE);
  if (!(await pathExists(path))) return defaultState();
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(20_000);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      const parsed = JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8"),
      ) as Partial<AutoUpdateState>;
      return {
        schemaVersion: 1,
        enabled: parsed.enabled === true,
        lastRunAt:
          typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : undefined,
        queuedAt:
          typeof parsed.queuedAt === "string" ? parsed.queuedAt : undefined,
        runningId:
          typeof parsed.runningId === "string" ? parsed.runningId : undefined,
        runningAt:
          typeof parsed.runningAt === "string" ? parsed.runningAt : undefined,
        lastSkipReason:
          typeof parsed.lastSkipReason === "string"
            ? parsed.lastSkipReason
            : undefined,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return defaultState();
  }
}

export async function writeAutoUpdateState(
  memoryRoot: string,
  state: AutoUpdateState,
): Promise<void> {
  const path = await assertInsideMemoryRoot(memoryRoot, AUTO_STATE_FILE);
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function removePendingEventId(
  memoryRoot: string,
  eventId: string,
): Promise<void> {
  await withMemoryLock(memoryRoot, "pending-events.lock", async () => {
    const path = await assertInsideMemoryRoot(memoryRoot, PENDING_EVENTS_FILE);
    if (!(await pathExists(path))) return;
    const lines = (await readFile(path, "utf8")).split("\n");
    const kept = lines.filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        const parsed = JSON.parse(trimmed) as { id?: unknown };
        return parsed.id !== eventId;
      } catch {
        return true;
      }
    });
    await atomicWriteFile(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  });
}

async function appendAutoUpdateLog(
  memoryRoot: string,
  value: unknown,
): Promise<void> {
  const path = await assertInsideMemoryRoot(memoryRoot, AUTO_UPDATE_LOG_FILE);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function setAutoUpdateEnabled(
  memory: ProjectMemoryContext,
  enabled: boolean,
): Promise<AutoUpdateState> {
  return withMemoryLock(memory.memoryRoot, "auto-update.lock", async () => {
    const current = await readAutoUpdateState(memory.memoryRoot);
    const next: AutoUpdateState = enabled
      ? { ...current, schemaVersion: 1, enabled }
      : {
          ...current,
          schemaVersion: 1,
          enabled,
          queuedAt: undefined,
          runningId: undefined,
          runningAt: undefined,
        };
    await writeAutoUpdateState(memory.memoryRoot, next);
    if (!enabled) {
      for (const controller of activeRuns.get(memory.memoryRoot)?.values() ??
        []) {
        controller.abort("disabled");
      }
    }
    return next;
  });
}

async function recordSkip(
  memoryRoot: string,
  reason: string,
  runningId?: string,
): Promise<void> {
  await withMemoryLock(memoryRoot, "auto-update.lock", async () => {
    const state = await readAutoUpdateState(memoryRoot);
    const ownsRunningState =
      runningId !== undefined && state.runningId === runningId;
    const preserveRunningState =
      reason === "already running" ||
      (state.runningId !== undefined && !ownsRunningState);
    await writeAutoUpdateState(memoryRoot, {
      ...state,
      queuedAt: preserveRunningState ? state.queuedAt : undefined,
      runningId: preserveRunningState ? state.runningId : undefined,
      runningAt: preserveRunningState ? state.runningAt : undefined,
      lastSkipReason: reason,
    });
    await appendAutoUpdateLog(memoryRoot, {
      createdAt: nowIso(),
      action: "skip",
      reason,
    });
  });
}

async function isRunStillEnabled(
  memoryRoot: string,
  runningId: string,
): Promise<boolean> {
  return withMemoryLock(memoryRoot, "auto-update.lock", async () => {
    const state = await readAutoUpdateState(memoryRoot);
    return state.enabled && state.runningId === runningId;
  });
}

function registerActiveRun(
  memoryRoot: string,
  runningId: string,
  externalSignal?: AbortSignal,
): { signal: AbortSignal; unregister: () => void } {
  const controller = new AbortController();
  if (externalSignal?.aborted) controller.abort(externalSignal.reason);
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener("abort", abortFromExternal, { once: true });
  let runs = activeRuns.get(memoryRoot);
  if (!runs) {
    runs = new Map();
    activeRuns.set(memoryRoot, runs);
  }
  runs.set(runningId, controller);
  return {
    signal: controller.signal,
    unregister: () => {
      externalSignal?.removeEventListener("abort", abortFromExternal);
      const currentRuns = activeRuns.get(memoryRoot);
      currentRuns?.delete(runningId);
      if (currentRuns?.size === 0) activeRuns.delete(memoryRoot);
    },
  };
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Project memory auto-update aborted"));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(new Error("Project memory auto-update aborted"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function beginQueuedUpdate(
  memoryRoot: string,
  now: Date,
  runningId: string,
): Promise<"queued" | "disabled" | "min interval" | "already running"> {
  return withMemoryLock(memoryRoot, "auto-update.lock", async () => {
    const state = await readAutoUpdateState(memoryRoot);
    if (!state.enabled) return "disabled";
    if (state.runningId) return "already running";
    if (
      state.lastRunAt &&
      now.getTime() - Date.parse(state.lastRunAt) < MIN_INTERVAL_MS
    ) {
      return "min interval";
    }
    await writeAutoUpdateState(memoryRoot, {
      ...state,
      queuedAt: nowIso(now),
      runningId,
      runningAt: nowIso(now),
      lastSkipReason: undefined,
    });
    return "queued";
  });
}

async function finishQueuedUpdateUnlocked(
  memoryRoot: string,
  now: Date,
  decision: AutoUpdateDecision,
  result: unknown,
  runningId: string,
): Promise<void> {
  const state = await readAutoUpdateState(memoryRoot);
  if (state.runningId !== runningId) return;
  await writeAutoUpdateState(memoryRoot, {
    schemaVersion: 1,
    enabled: state.enabled,
    lastRunAt: nowIso(now),
    lastSkipReason: state.lastSkipReason,
  });
  await appendAutoUpdateLog(memoryRoot, {
    createdAt: nowIso(now),
    action: "update",
    score: decision.score,
    reasons: decision.reasons,
    result,
  });
}

export async function maybeAutoUpdateProjectMemory(
  event: AgentEndLike,
  ctx: AutoUpdateContext,
  now = new Date(),
): Promise<AutoUpdateDecision> {
  const decision = scoreAgentEnd(event);
  if (!decision.shouldUpdate) return decision;

  const memory = await resolveMemoryContext(ctx.cwd);
  if (!memory) return decision;

  if (ctx.isIdle && !ctx.isIdle()) {
    await recordSkip(memory.memoryRoot, "not idle");
    return decision;
  }
  const runningId = randomUUID();
  const activeRun = registerActiveRun(memory.memoryRoot, runningId, ctx.signal);
  if (activeRun.signal.aborted) {
    activeRun.unregister();
    return decision;
  }
  let queueStatus: Awaited<ReturnType<typeof beginQueuedUpdate>>;
  try {
    queueStatus = await beginQueuedUpdate(memory.memoryRoot, now, runningId);
  } catch (error) {
    activeRun.unregister();
    throw error;
  }
  if (queueStatus !== "queued") {
    activeRun.unregister();
    await recordSkip(memory.memoryRoot, queueStatus);
    return decision;
  }
  try {
    await sleepWithAbort(ctx.debounceMs ?? DEBOUNCE_MS, activeRun.signal);
    if (ctx.isIdle && !ctx.isIdle()) {
      await recordSkip(memory.memoryRoot, "not idle after debounce", runningId);
      return decision;
    }
    if (!(await isRunStillEnabled(memory.memoryRoot, runningId))) {
      await recordSkip(memory.memoryRoot, "disabled during update", runningId);
      return decision;
    }

    const checkpoint = await buildCheckpointEvent(ctx.cwd, ctx, now);
    await withMemoryLock(memory.memoryRoot, "auto-update.lock", async () => {
      const state = await readAutoUpdateState(memory.memoryRoot);
      if (
        !state.enabled ||
        state.runningId !== runningId ||
        activeRun.signal.aborted
      ) {
        throw new Error("Project memory auto-update disabled during update");
      }
      await appendPendingEvent(memory, checkpoint);
    });
    if (activeRun.signal.aborted) {
      await removePendingEventId(memory.memoryRoot, checkpoint.id);
      await recordSkip(memory.memoryRoot, "disabled during update", runningId);
      return decision;
    }
    if (ctx.isIdle && !ctx.isIdle()) {
      await recordSkip(
        memory.memoryRoot,
        "not idle before consolidation",
        runningId,
      );
      return decision;
    }
    if (!(await isRunStillEnabled(memory.memoryRoot, runningId))) {
      await recordSkip(memory.memoryRoot, "disabled during update", runningId);
      return decision;
    }

    await consolidateProjectMemory(memory, {
      ...ctx,
      signal: activeRun.signal,
      runMutation: async (fn) =>
        withMemoryLock(memory.memoryRoot, "auto-update.lock", async () => {
          const state = await readAutoUpdateState(memory.memoryRoot);
          if (
            !state.enabled ||
            state.runningId !== runningId ||
            activeRun.signal.aborted
          ) {
            throw new Error(
              "Project memory auto-update disabled during update",
            );
          }
          return fn();
        }),
      afterMutation: (result) =>
        finishQueuedUpdateUnlocked(
          memory.memoryRoot,
          now,
          decision,
          result,
          runningId,
        ),
    });
  } catch (error) {
    await recordSkip(
      memory.memoryRoot,
      activeRun.signal.aborted ? "disabled during update" : "update failed",
      runningId,
    );
    if (!activeRun.signal.aborted) throw error;
  } finally {
    activeRun.unregister();
  }

  return decision;
}

export async function flushCheckpointOnly(
  ctx: AutoUpdateContext,
  now = new Date(),
): Promise<PendingEvent | undefined> {
  const memory = await resolveMemoryContext(ctx.cwd);
  if (!memory) return undefined;
  if (
    (await countPendingEvents(memory.memoryRoot)) >=
    MAX_PENDING_EVENTS_BEFORE_SHUTDOWN_FLUSH
  ) {
    return undefined;
  }
  const event = await buildCheckpointEvent(ctx.cwd, ctx, now);
  if (
    !event.objective &&
    !event.changedFilesStat &&
    event.commands.length === 0
  ) {
    return undefined;
  }
  await appendPendingEvent(memory, event);
  return event;
}
