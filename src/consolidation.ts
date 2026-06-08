import { complete, type Model } from "@earendil-works/pi-ai";
import { open, readFile } from "node:fs/promises";
import { redactSecrets, truncateUtf8, type PendingEvent } from "./events";
import {
  applyCandidates,
  factId,
  parseFact,
  readFacts,
  writeFacts,
  writeMemoryArtifacts,
  type FactCandidate,
  type ProjectFact,
} from "./facts";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  pathExists,
  withMemoryLock,
} from "./storage";
import type { ProjectMemoryContext } from "./types";

const PENDING_EVENTS_FILE = "pending-events.jsonl";
const PENDING_CONFIRMATIONS_FILE = "pending-confirmations.jsonl";
const UPDATE_LOG_FILE = "update-log.jsonl";
const USAGE_FILE = "usage.json";
const MAX_PENDING_BYTES = 500_000;
const MAX_MODEL_INPUT_CHARS = 48_000;
const DEFAULT_DAILY_INPUT_BUDGET = 60_000;
const DEFAULT_DAILY_OUTPUT_BUDGET = 10_000;
const MODEL_OUTPUT_BUDGET_RESERVATION = 2_000;

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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
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
    value.kind === "checkpoint" &&
    Array.isArray(value.commands) &&
    value.commands.every((command) => typeof command === "string")
  ) {
    return {
      ...base,
      kind: "checkpoint",
      objective:
        typeof value.objective === "string"
          ? truncateUtf8(redactSecrets(value.objective), 1_200).text
          : undefined,
      assistantSummary:
        typeof value.assistantSummary === "string"
          ? truncateUtf8(redactSecrets(value.assistantSummary), 4_000).text
          : undefined,
      changedFilesStat:
        typeof value.changedFilesStat === "string"
          ? truncateUtf8(redactSecrets(value.changedFilesStat), 8_000).text
          : undefined,
      changedFilesStatTruncated: value.changedFilesStatTruncated === true,
      commands: value.commands
        .slice(0, 20)
        .map((command) => truncateUtf8(redactSecrets(command), 1_200).text),
      fallbackNotes: Array.isArray(value.fallbackNotes)
        ? value.fallbackNotes
            .filter((note) => typeof note === "string")
            .slice(0, 20)
            .map((note) => truncateUtf8(redactSecrets(note), 1_200).text)
        : [],
    };
  }
  return undefined;
}

async function readPendingEvents(
  path: string,
  maxBytes: number,
): Promise<PendingEvent[]> {
  if (!(await pathExists(path))) return [];
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes)
      throw new Error("Pending events exceed size limit");
    const events: PendingEvent[] = [];
    for (const line of buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = parsePendingEvent(JSON.parse(trimmed) as unknown);
        if (event) events.push(event);
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
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(100_000);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return parseUsage(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown,
    );
  } catch {
    return { days: {} };
  } finally {
    await handle.close();
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

function noteFact(note: string, event: PendingEvent, now: Date): ProjectFact {
  return {
    schemaVersion: 1,
    id: factId("note", note),
    kind: "observation",
    topic: "other",
    scope: "whole_project",
    text: note,
    evidence: [
      { type: "user", note: `Explicit note from pending event ${event.id}` },
    ],
    confidence: "verified",
    status: "active",
    stalenessTriggers: [],
    sourceEventIds: [event.id],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastVerifiedAt: now.toISOString(),
  };
}

function manualNoteCandidates(
  events: PendingEvent[],
  now = new Date(),
): FactCandidate[] {
  const candidates: FactCandidate[] = [];
  for (const event of events) {
    if (event.kind === "note") {
      candidates.push({
        action: "add",
        fact: noteFact(event.text, event, now),
        confirmationRequired: false,
        reason: "explicit user-approved note",
      });
    }
  }
  return candidates;
}

function parseCandidate(raw: unknown): FactCandidate | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.action !== "add" &&
    value.action !== "update" &&
    value.action !== "remove"
  )
    return undefined;
  const reason =
    typeof value.reason === "string"
      ? truncateUtf8(redactSecrets(value.reason), 1_200).text
      : "model candidate";
  if (value.action === "remove") {
    if (typeof value.factId !== "string") return undefined;
    return {
      action: "remove",
      factId: value.factId,
      confirmationRequired: true,
      reason,
    };
  }
  const fact = parseFact(value.fact);
  if (!fact) return undefined;
  return {
    action: value.action,
    fact,
    confirmationRequired: value.confirmationRequired !== false,
    reason,
  };
}

function parseModelCandidates(text: string): FactCandidate[] | undefined {
  const jsonText = text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text;
  try {
    const parsed = JSON.parse(jsonText) as
      | { candidates?: unknown[] }
      | unknown[];
    const rawCandidates = Array.isArray(parsed) ? parsed : parsed.candidates;
    if (!Array.isArray(rawCandidates)) return undefined;
    return rawCandidates
      .map(parseCandidate)
      .filter((candidate): candidate is FactCandidate => Boolean(candidate));
  } catch {
    return undefined;
  }
}

type ModelCandidateResult =
  | { candidates: FactCandidate[]; reason?: undefined }
  | { candidates?: undefined; reason: string };

function candidateModels(ctx: ConsolidationContext): Model<any>[] {
  const models: Model<any>[] = [];
  if (ctx.model) models.push(ctx.model);
  const defaultModel = ctx.modelRegistry?.find("google", "gemini-2.5-flash");
  if (
    defaultModel &&
    !models.some(
      (model) =>
        model.provider === defaultModel.provider &&
        model.id === defaultModel.id,
    )
  ) {
    models.push(defaultModel);
  }
  return models;
}

async function modelCandidates(
  ctx: ConsolidationContext,
  input: string,
): Promise<ModelCandidateResult> {
  if (!ctx.modelRegistry) return { reason: "no model registry" };
  const models = candidateModels(ctx);
  if (models.length === 0) return { reason: "no model" };
  let sawAuthFailure = false;
  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      sawAuthFailure = true;
      continue;
    }
    let response;
    try {
      response = await complete(
        model,
        {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: `Convert pending project-memory events into conservative project-scoped fact candidates. Return JSON only: {"candidates":[...]}. Fact shape requires schemaVersion=1, kind, topic, scope, text, evidence, confidence, status, stalenessTriggers, sourceEventIds, timestamps. Descriptive source-backed facts from codebase exploration may set confirmationRequired=false. Normative/testing/coding conventions must set confirmationRequired=true unless explicitly user-provided. If no durable reliable facts would help a future agent, return {"candidates":[]}.\n\n${input}`,
                },
              ],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: 2_000,
          signal: ctx.signal,
        },
      );
    } catch {
      return { reason: "model completion failed" };
    }
    const text = response.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n");
    const candidates = parseModelCandidates(text);
    if (!candidates) return { reason: "model produced invalid output" };
    return { candidates };
  }
  return { reason: sawAuthFailure ? "model auth unavailable" : "no model" };
}

function buildInput(events: PendingEvent[], facts: ProjectFact[]): string {
  const input = redactSecrets(
    JSON.stringify(
      {
        existingFacts: facts.slice(0, 100),
        pendingEvents: events,
      },
      null,
      2,
    ),
  );
  return truncateUtf8(input, MAX_MODEL_INPUT_CHARS).text;
}

async function approveCandidates(
  ctx: ConsolidationContext,
  candidates: FactCandidate[],
  memoryRoot: string,
): Promise<Set<number>> {
  const approved = new Set<number>();
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate.fact && !candidate.factId) continue;
    if (!candidate.confirmationRequired) {
      approved.add(index);
      continue;
    }
    throwIfAborted(ctx.signal);
    if (!ctx.hasUI || !ctx.ui?.confirm) {
      throwIfAborted(ctx.signal);
      await appendJsonl(memoryRoot, PENDING_CONFIRMATIONS_FILE, candidate);
      continue;
    }
    const label = candidate.fact
      ? `${candidate.fact.kind}/${candidate.fact.topic}: ${candidate.fact.text}`
      : `remove fact: ${candidate.factId}`;
    const ok = await ctx.ui.confirm(
      "Apply project memory candidate?",
      `${label}\n\nReason: ${candidate.reason}`,
    );
    throwIfAborted(ctx.signal);
    if (ok) approved.add(index);
    else await appendJsonl(memoryRoot, PENDING_CONFIRMATIONS_FILE, candidate);
  }
  return approved;
}

async function removeProcessedPendingEvents(
  memoryRoot: string,
  processedEventIds: Set<string>,
): Promise<void> {
  await withMemoryLock(memoryRoot, "pending-events.lock", async () => {
    const pendingPath = await assertInsideMemoryRoot(
      memoryRoot,
      PENDING_EVENTS_FILE,
    );
    if (!(await pathExists(pendingPath))) return;
    const content = await readFile(pendingPath, "utf8");
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
      pendingPath,
      kept.length > 0 ? `${kept.join("\n")}\n` : "",
    );
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Project memory consolidation aborted");
}

export async function consolidateProjectMemory(
  memory: ProjectMemoryContext,
  ctx: ConsolidationContext = {},
  options: ConsolidationOptions = {},
): Promise<ConsolidationResult> {
  return withMemoryLock(memory.memoryRoot, "consolidation.lock", async () => {
    throwIfAborted(ctx.signal);
    const allEvents = await withMemoryLock(
      memory.memoryRoot,
      "pending-events.lock",
      async () => {
        const pendingPath = await assertInsideMemoryRoot(
          memory.memoryRoot,
          PENDING_EVENTS_FILE,
        );
        return readPendingEvents(pendingPath, MAX_PENDING_BYTES);
      },
    );
    const events = options.eventIds
      ? allEvents.filter((event) => options.eventIds?.has(event.id))
      : allEvents;
    if (events.length === 0) {
      return {
        applied: 0,
        pendingConfirmation: 0,
        mode: "skipped",
        reason: "no pending events",
        inputEstimate: 0,
        outputEstimate: 0,
      };
    }

    const runMutation = ctx.runMutation ?? (<T>(fn: () => Promise<T>) => fn());
    const noteEvents = events.filter((event) => event.kind === "note");
    const checkpointEvents = events.filter(
      (event) => event.kind === "checkpoint",
    );
    const hasCheckpoint = checkpointEvents.length > 0;
    const facts = await readFacts(memory.memoryRoot);
    const input = buildInput(checkpointEvents, facts);
    const inputEstimate = hasCheckpoint ? estimateTokens(input) : 0;
    const usage = await readUsage(memory.memoryRoot);
    const day = utcDay();
    const today = usage.days[day] ?? { input: 0, output: 0 };

    let mode: ConsolidationResult["mode"] = "manual";
    let reason: string | undefined;
    const candidates: FactCandidate[] = manualNoteCandidates(noteEvents);
    let nextUsage: UsageAccounting = usage;
    let writeUsageAfterMutation = false;
    const processedEventIds = new Set(noteEvents.map((event) => event.id));

    if (hasCheckpoint) {
      if (today.input + inputEstimate > DEFAULT_DAILY_INPUT_BUDGET) {
        if (candidates.length === 0) {
          throw new Error("Project memory daily input token budget exhausted");
        }
        reason = "model budget exhausted";
      } else {
        const outputRemaining = DEFAULT_DAILY_OUTPUT_BUDGET - today.output;
        if (outputRemaining < MODEL_OUTPUT_BUDGET_RESERVATION) {
          if (candidates.length === 0) {
            throw new Error(
              "Project memory daily output token budget exhausted",
            );
          }
          reason = "model budget exhausted";
        } else {
          const modelResult = await modelCandidates(ctx, input);
          throwIfAborted(ctx.signal);
          if (!modelResult.candidates) {
            reason = modelResult.reason;
          } else {
            mode = "model";
            const generated = modelResult.candidates;
            const manualCandidateCount = candidates.length;
            candidates.push(...generated);
            for (const event of checkpointEvents)
              processedEventIds.add(event.id);
            writeUsageAfterMutation = true;
            const generatedOutputEstimate = estimateTokens(
              JSON.stringify(generated),
            );
            if (
              today.output + generatedOutputEstimate >
              DEFAULT_DAILY_OUTPUT_BUDGET
            ) {
              if (candidates.length === 0) {
                throw new Error(
                  "Project memory daily output token budget exhausted",
                );
              }
              mode = "manual";
              reason = "model budget exhausted";
              candidates.splice(manualCandidateCount);
              for (const event of checkpointEvents) {
                processedEventIds.delete(event.id);
              }
              writeUsageAfterMutation = false;
            } else {
              nextUsage = {
                days: {
                  ...usage.days,
                  [day]: {
                    input: today.input + inputEstimate,
                    output: today.output + generatedOutputEstimate,
                  },
                },
              };
            }
          }
        }
      }
    }

    if (candidates.length === 0 && reason) {
      const result: ConsolidationResult = {
        applied: 0,
        pendingConfirmation: 0,
        mode: "skipped",
        reason,
        inputEstimate,
        outputEstimate: 0,
      };
      await appendJsonl(memory.memoryRoot, UPDATE_LOG_FILE, {
        createdAt: new Date().toISOString(),
        mode: result.mode,
        reason,
        pendingEvents: events.length,
        candidates: 0,
        applied: 0,
        inputEstimate,
        outputEstimate: 0,
      });
      await ctx.afterMutation?.(result);
      return result;
    }

    const outputEstimate = estimateTokens(JSON.stringify(candidates));
    const approved = await approveCandidates(
      ctx,
      candidates,
      memory.memoryRoot,
    );
    throwIfAborted(ctx.signal);

    const result: ConsolidationResult = {
      applied: approved.size,
      pendingConfirmation: candidates.filter(
        (candidate, index) =>
          candidate.confirmationRequired && !approved.has(index),
      ).length,
      mode,
      reason,
      inputEstimate,
      outputEstimate,
    };
    await runMutation(async () => {
      throwIfAborted(ctx.signal);
      await withMemoryLock(memory.memoryRoot, "facts.lock", async () => {
        const latestFacts = await readFacts(memory.memoryRoot);
        const nextFacts = applyCandidates(latestFacts, candidates, approved);
        await writeFacts(memory.memoryRoot, nextFacts);
        await writeMemoryArtifacts(memory.memoryRoot, nextFacts);
      });
      if (writeUsageAfterMutation)
        await writeUsage(memory.memoryRoot, nextUsage);
      await removeProcessedPendingEvents(memory.memoryRoot, processedEventIds);
      await appendJsonl(memory.memoryRoot, UPDATE_LOG_FILE, {
        createdAt: new Date().toISOString(),
        mode,
        reason,
        pendingEvents: events.length,
        candidates: candidates.length,
        applied: approved.size,
        inputEstimate,
        outputEstimate,
      });
      await ctx.afterMutation?.(result);
    });

    return result;
  });
}
