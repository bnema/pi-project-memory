import { readFile } from "node:fs/promises";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  pathExists,
  withMemoryLock,
} from "./storage";

// ── Types ──────────────────────────────────────────────────────────

export interface ManualNoteRecord {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  text: string;
  source: "tool" | "command";
}

// ── Constants ──────────────────────────────────────────────────────

const MANUAL_NOTES_FILE = "manual-notes.jsonl";

// ── Helpers ────────────────────────────────────────────────────────

export function parseManualNoteRecord(
  raw: unknown,
): ManualNoteRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.text !== "string" ||
    (value.source !== "tool" && value.source !== "command")
  ) {
    return undefined;
  }
  return value as unknown as ManualNoteRecord;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Read all manual note records from manual-notes.jsonl.
 *
 * Returns an empty array if the file does not exist or contains no valid records.
 */
export async function readManualNotes(
  memoryRoot: string,
): Promise<ManualNoteRecord[]> {
  const path = await assertInsideMemoryRoot(memoryRoot, MANUAL_NOTES_FILE);
  if (!(await pathExists(path))) return [];

  const content = await readFile(path, "utf8");
  const notes: ManualNoteRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = parseManualNoteRecord(JSON.parse(trimmed) as unknown);
      if (record) notes.push(record);
    } catch {
      continue;
    }
  }
  return notes;
}

/**
 * Append a manual note record to manual-notes.jsonl.
 *
 * Returns the generated note ID.
 */
export async function appendManualNote(
  memoryRoot: string,
  text: string,
  source: "tool" | "command" = "tool",
  now = new Date(),
  options: { id?: string; createdAt?: string } = {},
): Promise<string> {
  const record: ManualNoteRecord = {
    schemaVersion: 1,
    id:
      options.id ??
      `manual_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: options.createdAt ?? now.toISOString(),
    text,
    source,
  };

  const path = await assertInsideMemoryRoot(memoryRoot, MANUAL_NOTES_FILE);
  await withMemoryLock(memoryRoot, "manual-notes.lock", async () => {
    const existing = await readManualNotes(memoryRoot);
    const next = [
      ...existing.filter((note) => note.id !== record.id),
      record,
    ].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );
    await atomicWriteFile(
      path,
      next.length > 0
        ? `${next.map((note) => JSON.stringify(note)).join("\n")}\n`
        : "",
    );
  });

  return record.id;
}
