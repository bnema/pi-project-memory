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
const EVIDENCE_FILE = "evidence.jsonl";
const TRUSTED_NOTES_FILE = "trusted-notes.jsonl";
const MAX_EVIDENCE_EVENTS = 25;

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
    const parsed = JSON.parse(line) as PendingEvent;
    if (
      parsed?.schemaVersion === 1 &&
      (parsed.kind === "note" || parsed.kind === "evidence") &&
      typeof parsed.id === "string"
    ) {
      return parsed;
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
  const entries = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => ({ line, event: parsePendingEventLine(line) }));
  const evidenceEvents = entries.filter(
    (entry) => entry.event?.kind === "evidence",
  );
  if (evidenceEvents.length <= MAX_EVIDENCE_EVENTS) return;
  let evidenceToDrop = evidenceEvents.length - MAX_EVIDENCE_EVENTS;
  const kept = entries.filter((entry) => {
    if (entry.event?.kind !== "evidence") return true;
    if (evidenceToDrop <= 0) return true;
    evidenceToDrop -= 1;
    return false;
  });
  await atomicWriteFile(
    evidencePath,
    kept.length > 0 ? `${kept.map((entry) => entry.line).join("\n")}\n` : "",
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

async function countLines(path: string): Promise<number> {
  try {
    return (await readFile(path, "utf8"))
      .split("\n")
      .filter((line) => line.trim()).length;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return 0;
    throw error;
  }
}

export async function countPendingEvents(memoryRoot: string): Promise<number> {
  const evidenceCount = await countLines(
    await assertInsideMemoryRoot(memoryRoot, EVIDENCE_FILE),
  );
  const notesCount = await countLines(
    await assertInsideMemoryRoot(memoryRoot, TRUSTED_NOTES_FILE),
  );
  return evidenceCount + notesCount;
}
