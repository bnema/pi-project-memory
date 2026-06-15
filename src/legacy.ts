import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./storage";
import {
  MEMORY_SUMMARY_SCHEMA_VERSION,
  SUMMARY_FILE,
} from "./memory-artifacts";

const SUMMARY_SCHEMA_PATTERN =
  /<!--\s+memory-summary-schema:(\d+)\s+generated-at:(\S+)\s+records:(\d+)(?:\s+rendered-records:(\d+))?\s+notes:(\d+)\s+-->/;
const LEGACY_STORE_FILES = [
  "facts.jsonl",
  "pending-events.jsonl",
  "git-state.json",
] as const;
const CURRENT_SOURCE_FILES = [
  "stage1-outputs.jsonl",
  "manual-notes.jsonl",
] as const;

export interface SummarySchemaInfo {
  schemaVersion: number;
  generatedAt: Date;
  recordCount: number;
  renderedRecordCount?: number;
  noteCount: number;
}

export type SummaryValidationReason =
  | "missing-marker"
  | "unsupported-schema"
  | "future-generated-at"
  | "newer-source";

export interface SummaryValidationResult {
  ok: boolean;
  reason?: SummaryValidationReason;
  schema?: SummarySchemaInfo;
  newerSources?: string[];
}

export function parseSummarySchemaMarker(
  summary: string,
): SummarySchemaInfo | undefined {
  const trimmed = summary.trimStart();
  const firstLine = trimmed.split("\n")[0];
  if (!firstLine) return undefined;

  const match = firstLine.match(SUMMARY_SCHEMA_PATTERN);
  if (!match) return undefined;

  const schemaVersion = parseInt(match[1], 10);
  const generatedAt = new Date(match[2]);
  const recordCount = parseInt(match[3], 10);
  const renderedRecordCount = match[4] ? parseInt(match[4], 10) : undefined;
  const noteCount = parseInt(match[5], 10);

  if (
    !Number.isFinite(schemaVersion) ||
    Number.isNaN(generatedAt.getTime()) ||
    !Number.isFinite(recordCount) ||
    (renderedRecordCount !== undefined &&
      !Number.isFinite(renderedRecordCount)) ||
    !Number.isFinite(noteCount)
  ) {
    return undefined;
  }

  return {
    schemaVersion,
    generatedAt,
    recordCount,
    renderedRecordCount,
    noteCount,
  };
}

export function isSummaryFresh(
  infoOrSummary: SummarySchemaInfo | string,
  maxAgeMs?: number,
): boolean {
  const info =
    typeof infoOrSummary === "string"
      ? parseSummarySchemaMarker(infoOrSummary)
      : infoOrSummary;

  if (!info) return false;
  if (
    info.schemaVersion < 1 ||
    info.schemaVersion > MEMORY_SUMMARY_SCHEMA_VERSION
  ) {
    return false;
  }

  const age = Date.now() - info.generatedAt.getTime();
  if (age < 0) return false;
  if (maxAgeMs === undefined) return true;
  return age <= maxAgeMs;
}

async function newerSummarySources(
  memoryRoot: string,
  generatedAt: Date,
): Promise<string[]> {
  const newerSources: string[] = [];
  for (const file of CURRENT_SOURCE_FILES) {
    const filePath = join(memoryRoot, file);
    if (!(await pathExists(filePath))) continue;
    try {
      const fileStat = await stat(filePath);
      if (fileStat.mtimeMs > generatedAt.getTime()) {
        newerSources.push(file);
      }
    } catch {
      continue;
    }
  }
  return newerSources;
}

export async function validateSummaryForInjection(
  memoryRoot: string,
  summary: string,
): Promise<SummaryValidationResult> {
  const schema = parseSummarySchemaMarker(summary);
  if (!schema) return { ok: false, reason: "missing-marker" };
  if (!isSummaryFresh(schema)) {
    return {
      ok: false,
      reason:
        schema.generatedAt.getTime() > Date.now()
          ? "future-generated-at"
          : "unsupported-schema",
      schema,
    };
  }

  const newerSources = await newerSummarySources(
    memoryRoot,
    schema.generatedAt,
  );
  if (newerSources.length > 0) {
    return { ok: false, reason: "newer-source", schema, newerSources };
  }

  return { ok: true, schema };
}

export interface LegacyLayoutReport {
  hasOldFactsFile: boolean;
  hasLegacyPendingEventsFile: boolean;
  hasLegacyGitStateFile: boolean;
  hasUnversionedSummary: boolean;
  hasStage1Outputs: boolean;
  hasManualNotes: boolean;
  legacyFiles: string[];
  isLegacy: boolean;
  isMixedLayout: boolean;
}

export async function detectLegacyFiles(
  memoryRoot: string,
): Promise<LegacyLayoutReport> {
  const [hasOldFactsFile, hasLegacyPendingEventsFile, hasLegacyGitStateFile] =
    await Promise.all(
      LEGACY_STORE_FILES.map((file) => pathExists(join(memoryRoot, file))),
    );
  const [hasStage1Outputs, hasManualNotes] = await Promise.all(
    CURRENT_SOURCE_FILES.map((file) => pathExists(join(memoryRoot, file))),
  );

  let hasUnversionedSummary = false;
  const summaryPath = join(memoryRoot, SUMMARY_FILE);
  if (await pathExists(summaryPath)) {
    try {
      const content = await readFile(summaryPath, "utf8");
      hasUnversionedSummary = !parseSummarySchemaMarker(content);
    } catch {
      hasUnversionedSummary = true;
    }
  }

  const legacyFiles: string[] = [];
  if (hasOldFactsFile) legacyFiles.push("facts.jsonl");
  if (hasLegacyPendingEventsFile) legacyFiles.push("pending-events.jsonl");
  if (hasLegacyGitStateFile) legacyFiles.push("git-state.json");
  if (hasUnversionedSummary) legacyFiles.push("memory_summary.md(unversioned)");

  const hasCurrentFiles = hasStage1Outputs || hasManualNotes;
  const isLegacy = legacyFiles.length > 0;
  const isMixedLayout = isLegacy && hasCurrentFiles;

  return {
    hasOldFactsFile,
    hasLegacyPendingEventsFile,
    hasLegacyGitStateFile,
    hasUnversionedSummary,
    hasStage1Outputs,
    hasManualNotes,
    legacyFiles,
    isLegacy,
    isMixedLayout,
  };
}
