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
  mode: "model" | "fallback";
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

function commandFact(
  command: string,
  event: PendingEvent,
  now: Date,
): ProjectFact {
  const text = `Verified command observed: ${command}`;
  return {
    schemaVersion: 1,
    id: factId("command", command),
    kind: "command",
    topic: "tooling",
    scope: "whole_project",
    text,
    evidence: [
      { type: "checkpoint", note: `Captured from pending event ${event.id}` },
    ],
    confidence: "verified",
    status: "active",
    stalenessTriggers: ["package.json", "**/*test*", "**/*.config.*"],
    sourceEventIds: [event.id],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastVerifiedAt: now.toISOString(),
  };
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

function durableAssistantSummaryFact(
  summary: string,
  event: PendingEvent,
  now: Date,
): ProjectFact | undefined {
  const text = extractDurableProjectFact(summary);
  if (!text) return undefined;
  return {
    schemaVersion: 1,
    id: factId("summary", text),
    kind: "observation",
    topic: "architecture",
    scope: "whole_project",
    text,
    evidence: [
      {
        type: "checkpoint",
        note: `Durable project fact extracted from pending event ${event.id}`,
      },
    ],
    confidence: "medium",
    status: "active",
    stalenessTriggers: ["README*", "package.json", "src/**", "app/**"],
    sourceEventIds: [event.id],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastVerifiedAt: now.toISOString(),
  };
}

function extractDurableProjectFact(summary: string): string | undefined {
  const normalized = summary.replace(/\r\n/g, "\n");
  const projectText = extractLabeledValue(normalized, ["project", "projet"]);
  const architectureText = extractLabeledValue(normalized, [
    "architecture map",
    "architecture",
  ]);
  if (!projectText || !architectureText) return undefined;

  return truncateUtf8(
    `Project: ${projectText}. Architecture: ${architectureText}.`,
    1_200,
  ).text;
}

function extractLabeledValue(
  text: string,
  labels: readonly string[],
): string | undefined {
  const prepared = text
    .replace(/\n/g, " ")
    .replace(/(?:^|\s)[-*]\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const label of labels) {
    const value = matchLabeledValue(prepared, label);
    if (value) return value;
  }
  return undefined;
}

function matchLabeledValue(text: string, label: string): string | undefined {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nextLabel =
    "(?:^|[.!?]\\s+|\\s+)[A-ZÀ-ÖØ-Þ][\\p{L}\\d-]*(?:\\s+[\\p{L}\\d-]+){0,3}\\s*:";
  const match = new RegExp(
    `(?:^|[\\s.!?:])${escapedLabel}\\s*:?\\s*(.+?)(?=${nextLabel}|$)`,
    "iu",
  ).exec(text);
  if (!match) return undefined;
  return cleanLabeledValue(match[1]);
}

function cleanLabeledValue(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "");
  return cleaned || undefined;
}

export function fallbackCandidates(
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
    if (event.kind === "checkpoint") {
      if (event.assistantSummary) {
        const fact = durableAssistantSummaryFact(
          event.assistantSummary,
          event,
          now,
        );
        if (fact) {
          candidates.push({
            action: "add",
            fact,
            confirmationRequired: false,
            reason: "durable project fact extracted from checkpoint",
          });
        }
      }
      for (const command of event.commands) {
        candidates.push({
          action: "add",
          fact: commandFact(command, event, now),
          confirmationRequired: false,
          reason: "verified command captured in checkpoint",
        });
      }
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
    confirmationRequired: true,
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

async function modelCandidates(
  ctx: ConsolidationContext,
  input: string,
): Promise<FactCandidate[] | undefined> {
  const model =
    ctx.modelRegistry?.find("google", "gemini-2.5-flash") ?? ctx.model;
  if (!model || !ctx.modelRegistry) return undefined;
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) return undefined;
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
                text: `Convert pending project-memory events into conservative fact candidates. Return JSON only: {"candidates":[...]}. Fact shape requires schemaVersion=1, kind, topic, scope, text, evidence, confidence, status, stalenessTriggers, sourceEventIds, timestamps. Normative/testing/coding conventions must set confirmationRequired=true unless explicitly user-provided.\n\n${input}`,
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
    return undefined;
  }
  const text = response.content
    .filter(
      (part): part is { type: "text"; text: string } => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
  return parseModelCandidates(text);
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
    if (options.eventIds && events.length === 0) {
      return {
        applied: 0,
        pendingConfirmation: 0,
        mode: "fallback",
        inputEstimate: 0,
        outputEstimate: 0,
      };
    }
    const facts = await readFacts(memory.memoryRoot);
    const input = buildInput(events, facts);
    const inputEstimate = estimateTokens(input);
    const usage = await readUsage(memory.memoryRoot);
    const day = utcDay();
    const today = usage.days[day] ?? { input: 0, output: 0 };
    if (today.input + inputEstimate > DEFAULT_DAILY_INPUT_BUDGET) {
      throw new Error("Project memory daily input token budget exhausted");
    }

    const outputRemaining = DEFAULT_DAILY_OUTPUT_BUDGET - today.output;
    if (outputRemaining <= 0) {
      throw new Error("Project memory daily output token budget exhausted");
    }
    const generated =
      outputRemaining >= MODEL_OUTPUT_BUDGET_RESERVATION
        ? await modelCandidates(ctx, input)
        : undefined;
    throwIfAborted(ctx.signal);
    const mode = generated ? "model" : "fallback";
    const candidates = generated ?? fallbackCandidates(events);
    const outputEstimate = estimateTokens(JSON.stringify(candidates));
    if (today.output + outputEstimate > DEFAULT_DAILY_OUTPUT_BUDGET) {
      throw new Error("Project memory daily output token budget exhausted");
    }
    const approved = await approveCandidates(
      ctx,
      candidates,
      memory.memoryRoot,
    );
    throwIfAborted(ctx.signal);

    const nextUsage: UsageAccounting = {
      days: {
        ...usage.days,
        [day]: {
          input: today.input + inputEstimate,
          output: today.output + outputEstimate,
        },
      },
    };
    const runMutation = ctx.runMutation ?? (<T>(fn: () => Promise<T>) => fn());
    const result: ConsolidationResult = {
      applied: approved.size,
      pendingConfirmation: candidates.filter(
        (candidate, index) =>
          candidate.confirmationRequired && !approved.has(index),
      ).length,
      mode,
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
      await writeUsage(memory.memoryRoot, nextUsage);
      await removeProcessedPendingEvents(
        memory.memoryRoot,
        new Set(events.map((event) => event.id)),
      );
      await appendJsonl(memory.memoryRoot, UPDATE_LOG_FILE, {
        createdAt: new Date().toISOString(),
        mode,
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
