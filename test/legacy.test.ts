import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSummarySchemaMarker,
  isSummaryFresh,
  validateSummaryForInjection,
  detectLegacyFiles,
} from "../src/legacy";

const rootsToCleanup: string[] = [];

async function createTempDir(taskId: string): Promise<string> {
  const dir = join("/tmp", `pi-memory-legacy-${process.pid}-${taskId}`);
  rootsToCleanup.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => {}),
      ),
  );
});

describe("parseSummarySchemaMarker", () => {
  it("parses a valid schema marker", () => {
    const summary =
      "<!-- memory-summary-schema:1 generated-at:2026-06-15T12:00:00.000Z records:5 notes:1 -->\n## Memory Index\n...";
    const info = parseSummarySchemaMarker(summary);
    expect(info).toBeDefined();
    expect(info!.schemaVersion).toBe(1);
    expect(info!.recordCount).toBe(5);
    expect(info!.noteCount).toBe(1);
    expect(info!.generatedAt.toISOString()).toBe("2026-06-15T12:00:00.000Z");
  });

  it("returns undefined for empty string", () => {
    expect(parseSummarySchemaMarker("")).toBeUndefined();
  });

  it("returns undefined for old format without marker", () => {
    const summary =
      "## Manual Notes\n- Some note\n## Memory Index\n### Entry\n...";
    expect(parseSummarySchemaMarker(summary)).toBeUndefined();
  });

  it("returns undefined for non-marker content", () => {
    const summary = "## Memory Index\n### Routes\nSome memory.";
    expect(parseSummarySchemaMarker(summary)).toBeUndefined();
  });

  it("returns undefined for marker with missing fields", () => {
    const summary = "<!-- memory-summary-schema:1 -->\n## Memory Index\n...";
    expect(parseSummarySchemaMarker(summary)).toBeUndefined();
  });

  it("returns undefined for malformed marker", () => {
    const summary = "<!-- something-else:1 -->\n## Memory Index";
    expect(parseSummarySchemaMarker(summary)).toBeUndefined();
  });

  it("tolerates leading whitespace before the marker", () => {
    const summary =
      "\n\n<!-- memory-summary-schema:1 generated-at:2026-06-15T12:00:00.000Z records:3 notes:0 -->\n## Memory Index\n...";
    const info = parseSummarySchemaMarker(summary);
    expect(info).toBeDefined();
    expect(info!.recordCount).toBe(3);
  });
});

describe("isSummaryFresh", () => {
  const DEFAULT_MAX_AGE = 24 * 60 * 60 * 1000;

  it("returns true for recently generated summary", () => {
    const now = new Date().toISOString();
    const summary = `<!-- memory-summary-schema:1 generated-at:${now} records:5 notes:1 -->\n## Memory Index\n...`;
    expect(isSummaryFresh(summary)).toBe(true);
  });

  it("returns false for summary without marker", () => {
    expect(isSummaryFresh("## Memory Index\n...")).toBe(false);
  });

  it("returns false for summary older than an explicit max age", () => {
    const oldDate = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const summary = `<!-- memory-summary-schema:1 generated-at:${oldDate} records:5 notes:1 -->\n## Memory Index\n...`;
    expect(isSummaryFresh(summary, DEFAULT_MAX_AGE)).toBe(false);
  });

  it("returns true for old summary when no max age is enforced", () => {
    const oldDate = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const summary = `<!-- memory-summary-schema:1 generated-at:${oldDate} records:2 notes:0 -->\n## Memory Index\n...`;
    expect(isSummaryFresh(summary)).toBe(true);
  });

  it("returns false for future-dated summary (clock skew edge case)", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const summary = `<!-- memory-summary-schema:1 generated-at:${future} records:1 notes:0 -->\n## Memory Index\n...`;
    expect(isSummaryFresh(summary)).toBe(false);
  });
});

describe("validateSummaryForInjection", () => {
  it("rejects summary without schema marker", async ({ task }) => {
    const dir = await createTempDir(task.id);
    const result = await validateSummaryForInjection(
      dir,
      "## Memory Index\n...",
    );
    expect(result).toEqual({ ok: false, reason: "missing-marker" });
  });

  it("rejects summary when stage1 outputs are newer", async ({ task }) => {
    const dir = await createTempDir(task.id);
    const generatedAt = "2026-06-15T12:00:00.000Z";
    const summary = `<!-- memory-summary-schema:1 generated-at:${generatedAt} records:1 notes:0 -->\n## Memory Index\n...`;
    await writeFile(join(dir, "stage1-outputs.jsonl"), "{}\n", "utf8");
    const result = await validateSummaryForInjection(dir, summary);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("newer-source");
    expect(result.newerSources).toContain("stage1-outputs.jsonl");
  });

  it("rejects future-dated summary markers", async ({ task }) => {
    const dir = await createTempDir(task.id);
    const generatedAt = new Date(Date.now() + 2_000).toISOString();
    const summary = `<!-- memory-summary-schema:1 generated-at:${generatedAt} records:1 notes:0 -->\n## Memory Index\n...`;
    const result = await validateSummaryForInjection(dir, summary);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("future-generated-at");
  });

  it("accepts summary when schema is valid and no newer sources exist", async ({
    task,
  }) => {
    const dir = await createTempDir(task.id);
    const generatedAt = new Date(Date.now() - 2_000).toISOString();
    const summary = `<!-- memory-summary-schema:1 generated-at:${generatedAt} records:1 notes:0 -->\n## Memory Index\n...`;
    const result = await validateSummaryForInjection(dir, summary);
    expect(result.ok).toBe(true);
  });
});

describe("detectLegacyFiles", () => {
  it("returns clean report for an empty directory", async ({ task }) => {
    const dir = await createTempDir(task.id);
    const report = await detectLegacyFiles(dir);
    expect(report.isLegacy).toBe(false);
    expect(report.hasOldFactsFile).toBe(false);
    expect(report.hasUnversionedSummary).toBe(false);
    expect(report.hasStage1Outputs).toBe(false);
    expect(report.hasManualNotes).toBe(false);
  });

  it("detects old facts.jsonl legacy file", async ({ task }) => {
    const dir = await createTempDir(task.id);
    await writeFile(join(dir, "facts.jsonl"), "[]\n");
    const report = await detectLegacyFiles(dir);
    expect(report.hasOldFactsFile).toBe(true);
    expect(report.isLegacy).toBe(true);
  });

  it("detects unversioned memory_summary.md (no schema marker)", async ({
    task,
  }) => {
    const dir = await createTempDir(task.id);
    await writeFile(join(dir, "memory_summary.md"), "## Memory Index\n...");
    const report = await detectLegacyFiles(dir);
    expect(report.hasUnversionedSummary).toBe(true);
    expect(report.isLegacy).toBe(true);
  });

  it("detects versioned memory_summary.md as not legacy", async ({ task }) => {
    const dir = await createTempDir(task.id);
    await writeFile(
      join(dir, "memory_summary.md"),
      "<!-- memory-summary-schema:1 generated-at:2026-06-15T12:00:00.000Z records:2 notes:0 -->\n## Memory Index\n...",
    );
    const report = await detectLegacyFiles(dir);
    expect(report.hasUnversionedSummary).toBe(false);
    expect(report.isLegacy).toBe(false);
  });

  it("detects mixed layout (facts.jsonl and stage1-outputs.jsonl both present)", async ({
    task,
  }) => {
    const dir = await createTempDir(task.id);
    await writeFile(join(dir, "facts.jsonl"), "[]\n");
    await writeFile(join(dir, "stage1-outputs.jsonl"), "[]\n");
    const report = await detectLegacyFiles(dir);
    expect(report.hasOldFactsFile).toBe(true);
    expect(report.hasStage1Outputs).toBe(true);
    expect(report.isLegacy).toBe(true);
    expect(report.isMixedLayout).toBe(true);
  });

  it("detects pending-events and git-state legacy files", async ({ task }) => {
    const dir = await createTempDir(task.id);
    await writeFile(join(dir, "pending-events.jsonl"), "{}\n");
    await writeFile(join(dir, "git-state.json"), "{}\n");
    const report = await detectLegacyFiles(dir);
    expect(report.hasLegacyPendingEventsFile).toBe(true);
    expect(report.hasLegacyGitStateFile).toBe(true);
    expect(report.legacyFiles).toContain("pending-events.jsonl");
    expect(report.legacyFiles).toContain("git-state.json");
  });
});
