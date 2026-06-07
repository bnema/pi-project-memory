import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";
import {
  assertInsideMemoryRoot,
  initializeMemoryStorage,
  withMemoryLock,
} from "./storage";
import type { ProjectMemoryContext } from "./types";

const execFileAsync = promisify(execFile);
const MAX_NOTE_BYTES = 4_000;
const MAX_SNIPPET_BYTES = 1_200;
const MAX_DIFF_STAT_BYTES = 8_000;
const MAX_COMMANDS = 20;
const PENDING_EVENTS_FILE = "pending-events.jsonl";

export interface PendingEventBase {
  schemaVersion: 1;
  id: string;
  kind: "note" | "checkpoint";
  source: "tool" | "command";
  createdAt: string;
}

export interface PendingNoteEvent extends PendingEventBase {
  kind: "note";
  text: string;
  evidence: Array<{ type: "user"; note: string }>;
}

export interface PendingCheckpointEvent extends PendingEventBase {
  kind: "checkpoint";
  objective?: string;
  changedFilesStat?: string;
  changedFilesStatTruncated: boolean;
  commands: string[];
  fallbackNotes: string[];
}

export type PendingEvent = PendingNoteEvent | PendingCheckpointEvent;

export interface CheckpointSessionEntrySource {
  sessionManager?: {
    getBranch?: () => unknown[];
  };
}

function nowIso(now = new Date()): string {
  return now.toISOString();
}

function eventId(prefix: string, now = new Date()): string {
  return `${prefix}_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function truncateUtf8(
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: input, truncated: false };
  let text = buffer.subarray(0, maxBytes).toString("utf8").trimEnd();
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = text.slice(0, -1);
  }
  return { text, truncated: true };
}

export function redactSecrets(input: string): string {
  return input
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret)["']?\s*[=:]\s*)"[^"]*"/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret)["']?\s*[=:]\s*)'[^']*'/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret)["']?\s*[=:]\s*)[^\s,'"`;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
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

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
      ) {
        return (part as { text: string }).text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

export function extractLatestUserObjective(
  entries: unknown[],
): string | undefined {
  for (const entry of [...entries].reverse()) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
    if ((message as { role?: unknown }).role !== "user") continue;
    const text = textFromContent((message as { content?: unknown }).content);
    if (text?.trim()) return sanitizeText(text.trim(), MAX_SNIPPET_BYTES);
  }
  return undefined;
}

export function extractCommandStrings(entries: unknown[]): string[] {
  const commands: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const message = (entry as { message?: unknown }).message;
    if (!message || typeof message !== "object") continue;
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

export async function buildCheckpointEvent(
  cwd: string,
  source: CheckpointSessionEntrySource,
  now = new Date(),
): Promise<PendingCheckpointEvent> {
  const entries = source.sessionManager?.getBranch?.() ?? [];
  const diffStat = await gitDiffStat(cwd);
  const commands = extractCommandStrings(entries);
  const fallbackNotes: string[] = [];
  if (!diffStat.text) fallbackNotes.push("No git diff --stat output captured.");
  if (commands.length === 0)
    fallbackNotes.push("No command strings found in verified session entries.");

  return {
    schemaVersion: 1,
    id: eventId("checkpoint", now),
    kind: "checkpoint",
    source: "command",
    createdAt: nowIso(now),
    objective: extractLatestUserObjective(entries),
    changedFilesStat: diffStat.text,
    changedFilesStatTruncated: diffStat.truncated,
    commands,
    fallbackNotes,
  };
}

export async function appendPendingEvent(
  memory: ProjectMemoryContext,
  event: PendingEvent,
): Promise<void> {
  await initializeMemoryStorage(memory.identity);
  const pendingPath = await assertInsideMemoryRoot(
    memory.memoryRoot,
    PENDING_EVENTS_FILE,
  );
  await withMemoryLock(memory.memoryRoot, "pending-events.lock", async () => {
    const handle = await open(pendingPath, "a", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    } finally {
      await handle.close();
    }
  });
}

export async function countPendingEvents(memoryRoot: string): Promise<number> {
  const pendingPath = await assertInsideMemoryRoot(
    memoryRoot,
    PENDING_EVENTS_FILE,
  );
  try {
    const handle = await open(pendingPath, "r");
    try {
      const buffer = Buffer.alloc(100_000);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer
        .subarray(0, bytesRead)
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim()).length;
    } finally {
      await handle.close();
    }
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
