import { open, readFile } from "node:fs/promises";
import {
  redactSecrets,
  truncateUtf8,
  PENDING_FILE_READ_LIMIT_BYTES,
  type PendingEvent,
  type SessionEvidenceItem,
} from "./events";
import { appendManualNote } from "./manual-notes";
import { writeMemoryArtifacts } from "./memory-artifacts";
import {
  extractStage1Memory,
  persistStage1Output,
  pickStage1Models,
  type Stage1Output,
} from "./stage1";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  pathExists,
  withMemoryLock,
} from "./storage";
import type { ProjectMemoryContext } from "./types";
import type { Model } from "@earendil-works/pi-ai";

const EVIDENCE_FILE = "evidence.jsonl";
const TRUSTED_NOTES_FILE = "trusted-notes.jsonl";
const UPDATE_LOG_FILE = "update-log.jsonl";
const CONSOLIDATION_STATE_FILE = "consolidation-state.json";
const USAGE_FILE = "usage.json";
const MAX_EVIDENCE_BYTES = PENDING_FILE_READ_LIMIT_BYTES;
const MAX_MODEL_INPUT_CHARS = 48_000;
const DEFAULT_DAILY_INPUT_BUDGET = 60_000;
const DEFAULT_DAILY_OUTPUT_BUDGET = 10_000;
const MODEL_OUTPUT_BUDGET_RESERVATION = 2_000;
/**
 * Maximum number of pending events to process in one consolidation run
 * when no explicit eventIds are provided. Processing a bounded slice
 * prevents unbounded model consumption while still clearing the backlog
 * over multiple runs (newest processed first).
 */
const MAX_BATCH_EVENTS = 5;

export interface ConsolidationContext {
  hasUI?: boolean;
  signal?: AbortSignal;
  model?: Model<any>;
  modelRegistry?: {
    find(provider: string, modelId: string): Model<any> | undefined;
    getApiKeyAndHeaders(
      model: Model<any>,
    ): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
  ui?: {
    confirm(title: string, message: string): Promise<boolean>;
    notify(message: string, level?: "info" | "warning" | "error"): void;
  };
  runMutation?: <T>(fn: () => Promise<T>) => Promise<T>;
  afterMutation?: (result: ConsolidationResult) => Promise<void>;
}

export interface UsageAccounting {
  days: Record<string, { input: number; output: number }>;
}

export interface ConsolidationOptions {
  eventIds?: Set<string>;
}

export interface ConsolidationResult {
  applied: number;
  pendingConfirmation: number;
  mode: "model" | "manual" | "skipped";
  reason?: string;
  inputEstimate: number;
  outputEstimate: number;
}

/**
 * Persisted consolidation run outcome, written to consolidation-state.json
 * after each successful or skipped consolidation for downstream visibility
 * (e.g. memoryStatus, command notifications).
 */
export interface ConsolidationState {
  schemaVersion: 1;
  lastOutcome?: {
    at: string;
    mode: "model" | "manual" | "skipped";
    applied: number;
    pendingConfirmation: number;
    reason?: string;
    inputEstimate: number;
    outputEstimate: number;
  };
}

/**
 * Read the latest consolidation outcome from disk.
 * Returns undefined if no state file exists yet.
 */
export async function readConsolidationOutcome(
  memoryRoot: string,
): Promise<ConsolidationState | undefined> {
  const path = await assertInsideMemoryRoot(
    memoryRoot,
    CONSOLIDATION_STATE_FILE,
  );
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as ConsolidationState;
    return parsed.schemaVersion === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function isSessionEvidenceItem(value: unknown): value is SessionEvidenceItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    ["user", "assistant", "tool", "bash"].includes(String(item.type)) &&
    typeof item.content === "string" &&
    (item.source === undefined || typeof item.source === "string")
  );
}

function parsePendingEvent(raw: unknown): PendingEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string"
  )
    return undefined;
  const base = {
    schemaVersion: 1 as const,
    id: truncateUtf8(redactSecrets(value.id), 200).text,
    source:
      value.source === "command" ? ("command" as const) : ("tool" as const),
    createdAt: value.createdAt,
  };
  if (value.kind === "note" && typeof value.text === "string") {
    return {
      ...base,
      kind: "note",
      text: truncateUtf8(redactSecrets(value.text), 4_000).text,
      evidence: [{ type: "user", note: "Sanitized pending note event" }],
    };
  }
  if (
    value.kind === "evidence" &&
    Array.isArray(value.commands) &&
    value.commands.every((command) => typeof command === "string")
  ) {
    return {
      ...base,
      kind: "evidence",
      objective:
        typeof value.objective === "string"
          ? truncateUtf8(redactSecrets(value.objective), 1_200).text
          : undefined,
      evidence: Array.isArray(value.evidence)
        ? value.evidence.filter(isSessionEvidenceItem).map((item) => ({
            type: item.type,
            content: truncateUtf8(redactSecrets(item.content), 4_000).text,
            source:
              item.source !== undefined
                ? truncateUtf8(redactSecrets(item.source), 1_200).text
                : undefined,
          }))
        : [],
      changedFilesStat:
        typeof value.changedFilesStat === "string"
          ? truncateUtf8(redactSecrets(value.changedFilesStat), 8_000).text
          : undefined,
      changedFilesStatTruncated: value.changedFilesStatTruncated === true,
      commands: value.commands
        .slice(0, 20)
        .map((command) => truncateUtf8(redactSecrets(command), 1_200).text),
    };
  }
  return undefined;
}

async function readPendingEvents(
  path: string,
  maxBytes: number,
  expectedKind?: "evidence" | "note",
): Promise<PendingEvent[]> {
  if (!(await pathExists(path))) return [];
  const handle = await open(path, "r");
  try {
    const bufferSize = maxBytes + 1;
    const buffer = Buffer.alloc(bufferSize);
    const { bytesRead } = await handle.read(buffer, 0, bufferSize, 0);

    // Gracefully handle oversized files: read what fits within maxBytes
    // and parse only complete lines. Partial lines (truncated at the
    // byte boundary) are skipped via JSON.parse failure.
    const usableBytes = Math.min(bytesRead, maxBytes);
    const text = buffer.subarray(0, usableBytes).toString("utf8");

    const events: PendingEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = parsePendingEvent(JSON.parse(trimmed) as unknown);
        if (event && (!expectedKind || event.kind === expectedKind)) {
          events.push(event);
        }
      } catch {
        continue;
      }
    }
    return events;
  } finally {
    await handle.close();
  }
}

function parseUsage(raw: unknown): UsageAccounting {
  if (!raw || typeof raw !== "object") return { days: {} };
  const days = (raw as { days?: unknown }).days;
  if (!days || typeof days !== "object") return { days: {} };
  const parsed: UsageAccounting = { days: {} };
  for (const [day, value] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !value || typeof value !== "object")
      continue;
    const input = (value as { input?: unknown }).input;
    const output = (value as { output?: unknown }).output;
    parsed.days[day] = {
      input:
        typeof input === "number" && Number.isFinite(input) && input >= 0
          ? input
          : 0,
      output:
        typeof output === "number" && Number.isFinite(output) && output >= 0
          ? output
          : 0,
    };
  }
  return parsed;
}

async function readUsage(memoryRoot: string): Promise<UsageAccounting> {
  const path = await assertInsideMemoryRoot(memoryRoot, USAGE_FILE);
  if (!(await pathExists(path))) return { days: {} };
  try {
    return parseUsage(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return { days: {} };
  }
}

async function writeUsage(
  memoryRoot: string,
  usage: UsageAccounting,
): Promise<void> {
  const path = await assertInsideMemoryRoot(memoryRoot, USAGE_FILE);
  await atomicWriteFile(path, `${JSON.stringify(usage, null, 2)}\n`);
}

async function appendJsonl(
  memoryRoot: string,
  relativePath: string,
  value: unknown,
): Promise<void> {
  const path = await assertInsideMemoryRoot(memoryRoot, relativePath);
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

async function removeProcessedFromFile(
  memoryRoot: string,
  relativePath: string,
  lockName: string,
  processedEventIds: Set<string>,
): Promise<void> {
  await withMemoryLock(memoryRoot, lockName, async () => {
    const filePath = await assertInsideMemoryRoot(memoryRoot, relativePath);
    if (!(await pathExists(filePath))) return;
    const content = await readFile(filePath, "utf8");
    const kept = content.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        const parsed = JSON.parse(trimmed) as { id?: unknown };
        return (
          typeof parsed.id !== "string" || !processedEventIds.has(parsed.id)
        );
      } catch {
        return true;
      }
    });
    await atomicWriteFile(
      filePath,
      kept.length > 0 ? `${kept.join("\n")}\n` : "",
    );
  });
}

async function removeProcessedPendingEvents(
  memoryRoot: string,
  processedEventIds: Set<string>,
): Promise<void> {
  await removeProcessedFromFile(
    memoryRoot,
    EVIDENCE_FILE,
    "pending-events.lock",
    processedEventIds,
  );
  await removeProcessedFromFile(
    memoryRoot,
    TRUSTED_NOTES_FILE,
    "trusted-notes.lock",
    processedEventIds,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Project memory consolidation aborted");
}

async function writeConsolidationState(
  memoryRoot: string,
  outcome: ConsolidationState["lastOutcome"],
): Promise<void> {
  const state: ConsolidationState = { schemaVersion: 1, lastOutcome: outcome };
  const path = await assertInsideMemoryRoot(
    memoryRoot,
    CONSOLIDATION_STATE_FILE,
  );
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function evidenceInput(events: PendingEvent[]): SessionEvidenceItem[] {
  const items: SessionEvidenceItem[] = [];
  for (const event of events) {
    if (event.kind !== "evidence") continue;
    if (event.objective) items.push({ type: "user", content: event.objective });
    items.push(...event.evidence);
    if (event.changedFilesStat) {
      items.push({
        type: "tool",
        source: "git diff --stat",
        content: event.changedFilesStat,
      });
    }
    for (const command of event.commands) {
      items.push({ type: "bash", source: command, content: command });
    }
  }

  const bounded: SessionEvidenceItem[] = [];
  let size = 2;
  for (const item of items) {
    const sanitized: SessionEvidenceItem = {
      type: item.type,
      content: truncateUtf8(redactSecrets(item.content), 4_000).text,
      source:
        item.source !== undefined
          ? truncateUtf8(redactSecrets(item.source), 1_200).text
          : undefined,
    };
    const itemSize = Buffer.byteLength(JSON.stringify(sanitized), "utf8") + 1;
    if (size + itemSize > MAX_MODEL_INPUT_CHARS) break;
    bounded.push(sanitized);
    size += itemSize;
  }
  return bounded;
}

export async function consolidateProjectMemory(
  memory: ProjectMemoryContext,
  ctx: ConsolidationContext = {},
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  return withMemoryLock(memory.memoryRoot, "consolidation.lock", async () => {
    throwIfAborted(ctx.signal);
    const allEvents = await (async () => {
      const evidenceEvents = await withMemoryLock(
        memory.memoryRoot,
        "pending-events.lock",
        async () =>
          readPendingEvents(
            await assertInsideMemoryRoot(memory.memoryRoot, EVIDENCE_FILE),
            MAX_EVIDENCE_BYTES,
            "evidence",
          ),
      );
      const noteEvents = await withMemoryLock(
        memory.memoryRoot,
        "trusted-notes.lock",
        async () =>
          readPendingEvents(
            await assertInsideMemoryRoot(memory.memoryRoot, TRUSTED_NOTES_FILE),
            MAX_EVIDENCE_BYTES,
            "note",
          ),
      );
      return [...evidenceEvents, ...noteEvents];
    })();
    const events = options.eventIds
      ? allEvents.filter((event) => options.eventIds?.has(event.id))
      : allEvents
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, MAX_BATCH_EVENTS);
    const runMutation = ctx.runMutation ?? (<T>(fn: () => Promise<T>) => fn());
    if (events.length === 0) {
      const result: ConsolidationResult = {
        applied: 0,
        pendingConfirmation: 0,
        mode: "skipped",
        reason: "no pending events",
        inputEstimate: 0,
        outputEstimate: 0,
      };
      await runMutation(async () => {
        await writeConsolidationState(memory.memoryRoot, {
          at: new Date().toISOString(),
          mode: result.mode,
          applied: 0,
          pendingConfirmation: 0,
          reason: result.reason,
          inputEstimate: 0,
          outputEstimate: 0,
        });
        await appendJsonl(memory.memoryRoot, UPDATE_LOG_FILE, {
          createdAt: new Date().toISOString(),
          mode: result.mode,
          reason: result.reason,
          pendingEvents: 0,
          applied: 0,
          inputEstimate: 0,
          outputEstimate: 0,
        });
        await ctx.afterMutation?.(result);
      });
      return result;
    }

    const noteEvents = events.filter((event) => event.kind === "note");
    const evidenceEvents = events.filter((event) => event.kind === "evidence");
    const processedEventIds = new Set<string>();
    let applied = 0;
    let mode: ConsolidationResult["mode"] = noteEvents.length
      ? "manual"
      : "skipped";
    let reason: string | undefined;
    const input = evidenceInput(evidenceEvents);
    const inputEstimate =
      input.length > 0 ? estimateTokens(JSON.stringify(input)) : 0;
    let outputEstimate = 0;
    let nextUsage: UsageAccounting | undefined;
    let stage1OutputToPersist: Stage1Output | undefined;
    let stage1ModelUsed: string | undefined;

    const usage = await readUsage(memory.memoryRoot);
    const day = utcDay();
    const today = usage.days[day] ?? { input: 0, output: 0 };

    if (input.length > 0) {
      const maxStage1Attempts = Math.max(1, pickStage1Models(ctx).length);
      if (
        today.input + inputEstimate * maxStage1Attempts >
        DEFAULT_DAILY_INPUT_BUDGET
      ) {
        reason = "model budget exhausted";
      } else if (
        DEFAULT_DAILY_OUTPUT_BUDGET - today.output <
        MODEL_OUTPUT_BUDGET_RESERVATION
      ) {
        reason = "model budget exhausted";
      } else {
        const stage1 = await extractStage1Memory(input, ctx);
        throwIfAborted(ctx.signal);
        if ((stage1.attemptedCalls ?? 0) > 0) {
          outputEstimate = stage1.outputEstimate ?? 0;
          nextUsage = {
            days: {
              ...usage.days,
              [day]: {
                input:
                  today.input + inputEstimate * (stage1.attemptedCalls ?? 0),
                output: today.output + outputEstimate,
              },
            },
          };
        }

        if (stage1.status === "ok") {
          mode = "model";
          applied += 1;
          for (const event of evidenceEvents) processedEventIds.add(event.id);
          stage1OutputToPersist = stage1.output;
          stage1ModelUsed = stage1.modelUsed;
        } else if (
          stage1.status === "no-output" ||
          stage1.status === "rejected-low-quality"
        ) {
          mode = noteEvents.length ? "manual" : "skipped";
          reason = "model produced no durable memory";
          for (const event of evidenceEvents) processedEventIds.add(event.id);
        } else {
          reason = stage1.error ?? "memory extraction failed";
        }
      }
    }

    if (
      noteEvents.length === 0 &&
      applied === 0 &&
      reason &&
      processedEventIds.size === 0
    ) {
      const result: ConsolidationResult = {
        applied: 0,
        pendingConfirmation: 0,
        mode: "skipped",
        reason,
        inputEstimate,
        outputEstimate,
      };
      await runMutation(async () => {
        if (nextUsage) await writeUsage(memory.memoryRoot, nextUsage);
        await writeConsolidationState(memory.memoryRoot, {
          at: new Date().toISOString(),
          mode: result.mode,
          applied: 0,
          pendingConfirmation: 0,
          reason,
          inputEstimate,
          outputEstimate,
        });
        await appendJsonl(memory.memoryRoot, UPDATE_LOG_FILE, {
          createdAt: new Date().toISOString(),
          mode: result.mode,
          reason,
          pendingEvents: events.length,
          applied: 0,
          inputEstimate,
          outputEstimate,
        });
        await ctx.afterMutation?.(result);
      });
      return result;
    }

    const result: ConsolidationResult = {
      applied: applied + noteEvents.length,
      pendingConfirmation: 0,
      mode,
      reason,
      inputEstimate,
      outputEstimate,
    };
    await runMutation(async () => {
      throwIfAborted(ctx.signal);
      for (const event of noteEvents) {
        await appendManualNote(
          memory.memoryRoot,
          event.text,
          event.source,
          undefined,
          { id: event.id, createdAt: event.createdAt },
        );
        processedEventIds.add(event.id);
      }
      if (stage1OutputToPersist) {
        if (!stage1ModelUsed) throw new Error("Missing stage1 model identity");
        await persistStage1Output(
          memory.memoryRoot,
          stage1OutputToPersist,
          stage1ModelUsed,
        );
      }
      await writeMemoryArtifacts(memory.memoryRoot);
      if (nextUsage) await writeUsage(memory.memoryRoot, nextUsage);
      await removeProcessedPendingEvents(memory.memoryRoot, processedEventIds);
      await writeConsolidationState(memory.memoryRoot, {
        at: new Date().toISOString(),
        mode: result.mode,
        applied: result.applied,
        pendingConfirmation: result.pendingConfirmation,
        reason: result.reason,
        inputEstimate: result.inputEstimate,
        outputEstimate: result.outputEstimate,
      });
      await appendJsonl(memory.memoryRoot, UPDATE_LOG_FILE, {
        createdAt: new Date().toISOString(),
        mode,
        reason,
        pendingEvents: events.length,
        applied: result.applied,
        inputEstimate,
        outputEstimate,
      });
      await ctx.afterMutation?.(result);
    });

    return result;
  });
}
