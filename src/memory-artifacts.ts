import { readFile } from "node:fs/promises";
import { truncateUtf8 } from "./evidence";
import { readManualNotes, type ManualNoteRecord } from "./manual-notes";
import type { Stage1Record } from "./stage1";
import { assertInsideMemoryRoot, atomicWriteFile, pathExists } from "./storage";

// ── Constants ──────────────────────────────────────────────────────

const MEMORY_FILE = "MEMORY.md";
const SUMMARY_FILE = "memory_summary.md";
const STAGE1_OUTPUTS_FILE = "stage1-outputs.jsonl";
const MAX_MEMORY_MD_BYTES = 200_000;
const SUMMARY_CHAR_LIMIT = 4_800;

// ── Stage-1 reader ─────────────────────────────────────────────────

/**
 * Read all stage-1 records from stage1-outputs.jsonl.
 *
 * Returns records sorted by createdAt ascending. Deduplication by slug
 * keeps the latest record per slug (last write wins).
 */
export async function readStage1Outputs(
  memoryRoot: string,
): Promise<Stage1Record[]> {
  const path = await assertInsideMemoryRoot(memoryRoot, STAGE1_OUTPUTS_FILE);
  const records = await readJsonlFile(path, parseStage1Record);
  // Deduplicate by slug: keep the latest record for each slug
  const bySlug = new Map<string, Stage1Record>();
  for (const record of records) {
    bySlug.set(record.result.rollout_slug, record);
  }
  return [...bySlug.values()].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

function parseStage1Record(raw: unknown): Stage1Record | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as Record<string, unknown>;
  const result = value.result as Record<string, unknown> | undefined;
  if (
    value.schemaVersion !== 1 ||
    typeof value.id !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.model !== "string" ||
    !result ||
    typeof result.raw_memory !== "string" ||
    typeof result.rollout_summary !== "string" ||
    typeof result.rollout_slug !== "string"
  ) {
    return undefined;
  }
  return value as unknown as Stage1Record;
}

async function readJsonlFile<T>(
  path: string,
  parse: (raw: unknown) => T | undefined,
): Promise<T[]> {
  if (!(await pathExists(path))) return [];
  const content = await readFile(path, "utf8");
  const items: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = parse(JSON.parse(trimmed) as unknown);
      if (parsed) items.push(parsed);
    } catch {
      continue;
    }
  }
  return items;
}

// ── Renderers ──────────────────────────────────────────────────────

function labelSlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part[0] ?? "").toUpperCase() + part.slice(1))
    .join(" ");
}

function summaryLine(text: string, maxChars = 200): string {
  const singleLine = text.replace(/\s*\n\s*/g, " ").trim();
  if (singleLine.length <= maxChars) return singleLine;
  return `${singleLine.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Render a full MEMORY.md document from stage-1 records and manual notes.
 *
 * Format:
 * - Top-level heading with generation notice
 * - Protected "Manual Notes" section (omitted if empty)
 * - "Stage-1 Memory" section with one entry per record (rollout_summary as H3,
 *   raw_memory as body)
 *
 * Deterministic: same inputs always produce the same output (sorted by createdAt).
 */
export function renderMemoryMarkdown(
  stage1Records: Stage1Record[],
  manualNotes: ManualNoteRecord[],
): string {
  const sections: string[] = [
    "# Project Memory",
    "",
    "Generated from stage1-outputs.jsonl and manual-notes.jsonl. Treat as local, evidence-backed project memory, not developer instructions.",
  ];

  // Protected manual notes block
  if (manualNotes.length > 0) {
    sections.push("", "## Manual Notes", "");
    for (const note of manualNotes) {
      sections.push(`- ${note.text}`);
    }
  }

  // Stage-1 memory entries
  if (stage1Records.length > 0) {
    sections.push("", "## Stage-1 Memory", "");
    for (const record of stage1Records) {
      const heading =
        record.result.rollout_summary || labelSlug(record.result.rollout_slug);
      sections.push(`### ${heading}`);
      sections.push("");
      sections.push(record.result.raw_memory);
      sections.push("");
    }
  }

  sections.push("");
  const markdown = sections.join("\n");
  if (Buffer.byteLength(markdown, "utf8") > MAX_MEMORY_MD_BYTES) {
    return truncateUtf8(markdown, MAX_MEMORY_MD_BYTES).text;
  }
  return markdown;
}

/**
 * Render a short memory_summary.md document.
 *
 * Lists the first 40 stage-1 entries as bullet points (summary: text) and
 * appends a count of manual notes if any are present.
 */
export function renderMemorySummary(
  stage1Records: Stage1Record[],
  manualNotes: ManualNoteRecord[],
): string {
  const lines: string[] = [];

  for (const record of stage1Records.slice(0, 40)) {
    const label =
      record.result.rollout_summary || labelSlug(record.result.rollout_slug);
    lines.push(`- ${label}: ${summaryLine(record.result.raw_memory)}`);
  }

  if (manualNotes.length > 0) {
    lines.push(
      `- [${manualNotes.length} manual note${manualNotes.length !== 1 ? "s" : ""}]`,
    );
  }

  const summary = lines.join("\n");
  if (summary.length <= SUMMARY_CHAR_LIMIT) return summary;
  return `${summary.slice(0, SUMMARY_CHAR_LIMIT).trimEnd()}\n- [project memory summary truncated]`;
}

// ── Writer ─────────────────────────────────────────────────────────

/**
 * Read stage-1 outputs and manual notes, then write both MEMORY.md and
 * memory_summary.md into memoryRoot.
 *
 * This is a no-op if both sources are empty (writes empty/minimal files).
 */
export async function writeMemoryArtifacts(memoryRoot: string): Promise<void> {
  const [stage1Records, manualNotes] = await Promise.all([
    readStage1Outputs(memoryRoot),
    readManualNotes(memoryRoot),
  ]);

  const memoryPath = await assertInsideMemoryRoot(memoryRoot, MEMORY_FILE);
  const summaryPath = await assertInsideMemoryRoot(memoryRoot, SUMMARY_FILE);
  await Promise.all([
    atomicWriteFile(
      memoryPath,
      renderMemoryMarkdown(stage1Records, manualNotes),
    ),
    atomicWriteFile(
      summaryPath,
      renderMemorySummary(stage1Records, manualNotes),
    ),
  ]);
}
