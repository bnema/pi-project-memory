import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  initializeMemoryStorage,
  withMemoryLock,
} from "./storage";
import type { ProjectMemoryContext } from "./types";
import {
  truncateUtf8,
  redactSecrets,
  textFromContent,
  type SessionEvidenceItem,
  extractMessageObject,
  extractSessionEvidence,
} from "./evidence";

// Re-export shared utilities for downstream consumers.
export { truncateUtf8, redactSecrets };
export type { SessionEvidenceItem };

const execFileAsync = promisify(execFile);
const MAX_NOTE_BYTES = 4_000;
const MAX_SNIPPET_BYTES = 1_200;
const MAX_DIFF_STAT_BYTES = 8_000;
const MAX_COMMANDS = 20;
export const EVIDENCE_FILE = "evidence.jsonl";
export const TRUSTED_NOTES_FILE = "trusted-notes.jsonl";
const MAX_EVIDENCE_EVENTS = 25;
export const PENDING_FILE_READ_LIMIT_BYTES = 500_000;
export const PENDING_FILE_NEAR_LIMIT_BYTES = 400_000;
// Target byte size for evidence.jsonl — keep well under the read limit
// to allow headroom for concurrent appends.
export const EVIDENCE_FILE_TARGET_BYTES = 400_000;

export interface PendingEventBase {
  schemaVersion: 1;
  id: string;
  kind: "note" | "evidence";
  source: "tool" | "command";
  createdAt: string;
}

export interface PendingNoteEvent extends PendingEventBase {
  kind: "note";
  text: string;
  evidence: Array<{ type: "user"; note: string }>;
}

export interface PendingEvidenceEvent extends PendingEventBase {
  kind: "evidence";
  objective?: string;
  evidence: SessionEvidenceItem[];
  changedFilesStat?: string;
  changedFilesStatTruncated: boolean;
  commands: string[];
}

export type PendingEvent = PendingNoteEvent | PendingEvidenceEvent;

export interface SessionEntrySource {
  sessionManager?: {
    getBranch?: () => unknown[];
  };
  /** Explicit entry set, used when evidence should be built from a merged source. */
  entries?: unknown[];
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function eventId(prefix: string, now = new Date()): string {
  return `${prefix}_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function sanitizeText(input: string, maxBytes: number): string {
  return truncateUtf8(redactSecrets(input), maxBytes).text;
}

export function buildNoteEvent(
  text: string,
  source: "tool" | "command" = "tool",
  now = new Date(),
): PendingNoteEvent {
  const sanitized = sanitizeText(text.trim(), MAX_NOTE_BYTES);
  if (!sanitized) throw new Error("Project memory note must not be empty");
  return {
    schemaVersion: 1,
    id: eventId("note", now),
    kind: "note",
    source,
    createdAt: nowIso(now),
    text: sanitized,
    evidence: [
      {
        type: "user",
        note: "Explicit project_memory_note/project-memory note request",
      },
    ],
  };
}

export function extractLatestUserObjective(
  entries: unknown[],
): string | undefined {
  for (const entry of [...entries].reverse()) {
    const message = extractMessageObject(entry);
    if (!message) continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    const text = textFromContent((message as { content?: unknown }).content);
    if (text?.trim()) return sanitizeText(text.trim(), MAX_SNIPPET_BYTES);
  }
  return undefined;
}

export function extractCommandStrings(entries: unknown[]): string[] {
  const commands: string[] = [];
  for (const entry of entries) {
    const message = extractMessageObject(entry);
    if (!message) continue;
    const role = (message as { role?: unknown }).role;
    const toolName = (message as { toolName?: unknown }).toolName;
    const details = (message as { details?: unknown }).details;
    const command =
      role === "bashExecution"
        ? (message as { command?: unknown }).command
        : toolName === "bash" && details && typeof details === "object"
          ? (details as { command?: unknown }).command
          : undefined;
    if (typeof command === "string" && command.trim()) {
      commands.push(sanitizeText(command.trim(), MAX_SNIPPET_BYTES));
    }
    if (commands.length >= MAX_COMMANDS) break;
  }
  return commands;
}

export async function gitDiffStat(
  cwd: string,
): Promise<{ text?: string; truncated: boolean }> {
  try {
    const { stdout } = await execFileAsync("git", ["diff", "--stat"], {
      cwd,
      timeout: 5_000,
      maxBuffer: MAX_DIFF_STAT_BYTES * 4,
    });
    const truncated = truncateUtf8(stdout.trim(), MAX_DIFF_STAT_BYTES);
    return {
      text: truncated.text || undefined,
      truncated: truncated.truncated,
    };
  } catch {
    return { truncated: false };
  }
}

export async function buildEvidenceEvent(
  cwd: string,
  source: SessionEntrySource,
  now = new Date(),
): Promise<PendingEvidenceEvent> {
  const entries = source.entries ?? source.sessionManager?.getBranch?.() ?? [];
  const diffStat = await gitDiffStat(cwd);
  const commands = extractCommandStrings(entries);

  return {
    schemaVersion: 1,
    id: eventId("ev", now),
    kind: "evidence",
    source: "command",
    createdAt: nowIso(now),
    objective: extractLatestUserObjective(entries),
    evidence: extractSessionEvidence(entries),
    changedFilesStat: diffStat.text,
    changedFilesStatTruncated: diffStat.truncated,
    commands,
  };
}

function parsePendingEventLine(line: string): PendingEvent | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<PendingEvent>;
    if (
      parsed?.schemaVersion !== 1 ||
      typeof parsed.id !== "string" ||
      typeof parsed.createdAt !== "string"
    ) {
      return undefined;
    }
    if (parsed.kind === "note" && typeof parsed.text === "string") {
      return parsed as PendingEvent;
    }
    if (parsed.kind === "evidence" && Array.isArray(parsed.commands)) {
      return parsed as PendingEvent;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function pruneEvidenceBacklog(evidencePath: string): Promise<void> {
  let content = "";
  try {
    content = await readFile(evidencePath, "utf8");
  } catch {
    return;
  }
  const lines = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ line, event: parsePendingEventLine(line) }));

  // Phase 1: Count-based pruning — keep last MAX_EVIDENCE_EVENTS evidence events
  const evidenceCount = lines.filter(
    (entry) => entry.event?.kind === "evidence",
  ).length;
  let countPruned = [...lines];
  if (evidenceCount > MAX_EVIDENCE_EVENTS) {
    let evidenceToDrop = evidenceCount - MAX_EVIDENCE_EVENTS;
    countPruned = lines.filter((entry) => {
      if (entry.event?.kind !== "evidence") return true;
      if (evidenceToDrop <= 0) return true;
      evidenceToDrop -= 1;
      return false;
    });
  }

  // Phase 2: Byte-aware pruning — drop malformed/non-evidence lines first,
  // then drop the oldest remaining evidence events so the newest valid
  // evidence survives under the byte target.
  let bytePruned = [...countPruned];
  let prunedText = bytePruned.map((entry) => entry.line).join("\n");
  while (Buffer.byteLength(prunedText, "utf8") > EVIDENCE_FILE_TARGET_BYTES) {
    const nextMalformedIndex = bytePruned.findIndex(
      (entry) => entry.event?.kind !== "evidence",
    );
    const nextEvidenceIndex = bytePruned.findIndex(
      (entry) => entry.event?.kind === "evidence",
    );
    const nextDropIndex =
      nextMalformedIndex >= 0 ? nextMalformedIndex : nextEvidenceIndex;
    if (nextDropIndex < 0) break;
    bytePruned.splice(nextDropIndex, 1);
    prunedText = bytePruned.map((entry) => entry.line).join("\n");
  }

  await atomicWriteFile(
    evidencePath,
    prunedText.length > 0 ? `${prunedText}\n` : "",
  );
}

export async function appendPendingEvent(
  memory: ProjectMemoryContext,
  event: PendingEvent,
): Promise<void> {
  await initializeMemoryStorage(memory.identity);
  const isNote = event.kind === "note";
  const relativePath = isNote ? TRUSTED_NOTES_FILE : EVIDENCE_FILE;
  const lockName = isNote ? "trusted-notes.lock" : "pending-events.lock";
  const pendingPath = await assertInsideMemoryRoot(
    memory.memoryRoot,
    relativePath,
  );
  await withMemoryLock(memory.memoryRoot, lockName, async () => {
    const handle = await open(pendingPath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    if (!isNote) {
      await pruneEvidenceBacklog(pendingPath);
    }
  });
}

export interface PendingBacklogFileStats {
  count: number;
  bytes: number;
  malformedLines: number;
  oldestCreatedAt?: string;
  newestCreatedAt?: string;
  nearReadLimit: boolean;
  overReadLimit: boolean;
}

export interface PendingBacklogStats {
  evidence: PendingBacklogFileStats;
  notes: PendingBacklogFileStats;
  totalCount: number;
  totalBytes: number;
}

async function inspectPendingFile(
  path: string,
  expectedKind: PendingEvent["kind"],
): Promise<PendingBacklogFileStats> {
  try {
    const content = await readFile(path, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    let count = 0;
    let malformedLines = 0;
    let oldestCreatedAt: string | undefined;
    let newestCreatedAt: string | undefined;

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parsePendingEventLine(trimmed);
      if (!event || event.kind !== expectedKind) {
        malformedLines += 1;
        continue;
      }
      count += 1;
      if (!oldestCreatedAt || event.createdAt < oldestCreatedAt) {
        oldestCreatedAt = event.createdAt;
      }
      if (!newestCreatedAt || event.createdAt > newestCreatedAt) {
        newestCreatedAt = event.createdAt;
      }
    }

    return {
      count,
      bytes,
      malformedLines,
      oldestCreatedAt,
      newestCreatedAt,
      nearReadLimit: bytes >= PENDING_FILE_NEAR_LIMIT_BYTES,
      overReadLimit: bytes > PENDING_FILE_READ_LIMIT_BYTES,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return {
        count: 0,
        bytes: 0,
        malformedLines: 0,
        nearReadLimit: false,
        overReadLimit: false,
      };
    }
    throw error;
  }
}

export async function inspectPendingBacklog(
  memoryRoot: string,
): Promise<PendingBacklogStats> {
  const evidence = await inspectPendingFile(
    await assertInsideMemoryRoot(memoryRoot, EVIDENCE_FILE),
    "evidence",
  );
  const notes = await inspectPendingFile(
    await assertInsideMemoryRoot(memoryRoot, TRUSTED_NOTES_FILE),
    "note",
  );
  return {
    evidence,
    notes,
    totalCount: evidence.count + notes.count,
    totalBytes: evidence.bytes + notes.bytes,
  };
}

export async function countPendingEvents(memoryRoot: string): Promise<number> {
  return (await inspectPendingBacklog(memoryRoot)).totalCount;
}
