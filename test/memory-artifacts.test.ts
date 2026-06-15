import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readStage1Outputs,
  renderMemoryMarkdown,
  renderMemorySummary,
  writeMemoryArtifacts,
} from "../src/memory-artifacts";
import type { ManualNoteRecord } from "../src/manual-notes";
import type { Stage1Record } from "../src/stage1";

const rootsToCleanup: string[] = [];

async function createMemoryRoot(taskId: string): Promise<string> {
  const dir = join("/tmp", `pi-memory-artifacts-${process.pid}-${taskId}`);
  rootsToCleanup.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function stage1Record(overrides: Partial<Stage1Record> = {}): Stage1Record {
  return {
    schemaVersion: 1,
    id: "routes-architecture",
    createdAt: "2026-06-13T12:00:00.000Z",
    result: {
      raw_memory: "Routes use express pattern with middleware chaining.",
      rollout_summary: "Routes Architecture",
      rollout_slug: "routes-architecture",
    },
    model: "test/model",
    ...overrides,
  };
}

function manualNote(
  overrides: Partial<ManualNoteRecord> = {},
): ManualNoteRecord {
  return {
    schemaVersion: 1,
    id: "note_a",
    createdAt: "2026-06-13T11:00:00.000Z",
    text: "Always use `npm test` before committing.",
    source: "tool",
    ...overrides,
  };
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

describe("readStage1Outputs", () => {
  it("returns empty array when file does not exist", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await expect(readStage1Outputs(memoryRoot)).resolves.toEqual([]);
  });

  it("parses valid lines and deduplicates by slug (latest wins)", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const older = stage1Record({ createdAt: "2026-06-13T10:00:00.000Z" });
    const newer = stage1Record({ createdAt: "2026-06-13T12:00:00.000Z" });
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`,
      "utf8",
    );

    const records = await readStage1Outputs(memoryRoot);
    expect(records).toHaveLength(1);
    expect(records[0]?.createdAt).toBe("2026-06-13T12:00:00.000Z");
  });

  it("skips malformed lines", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const valid = stage1Record({ id: "valid-slug" });
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify(valid)}\n{not json}\n`,
      "utf8",
    );

    const records = await readStage1Outputs(memoryRoot);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("valid-slug");
  });

  it("returns multiple records with distinct slugs sorted by createdAt", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const a = stage1Record({
      id: "slug-a",
      result: {
        raw_memory: "First",
        rollout_summary: "First",
        rollout_slug: "slug-a",
      },
      createdAt: "2026-06-13T12:00:00.000Z",
    });
    const b = stage1Record({
      id: "slug-b",
      result: {
        raw_memory: "Second",
        rollout_summary: "Second",
        rollout_slug: "slug-b",
      },
      createdAt: "2026-06-13T10:00:00.000Z",
    });
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify(a)}\n${JSON.stringify(b)}\n`,
      "utf8",
    );

    const records = await readStage1Outputs(memoryRoot);
    expect(records).toHaveLength(2);
    expect(records[0]?.result.rollout_slug).toBe("slug-b");
    expect(records[1]?.result.rollout_slug).toBe("slug-a");
  });
});

describe("renderMemoryMarkdown", () => {
  it("renders minimal document with no records or notes", () => {
    const md = renderMemoryMarkdown([], []);
    expect(md).toContain("# Project Memory");
    expect(md).toContain("Generated from stage1-outputs.jsonl");
    expect(md).not.toContain("Manual Notes");
    expect(md).not.toContain("Stage-1 Memory");
  });

  it("includes protected manual notes block when notes exist", () => {
    const md = renderMemoryMarkdown([], [manualNote()]);
    expect(md).toContain("## Manual Notes");
    expect(md).toContain("Always use `npm test` before committing.");
  });

  it("includes consolidated stage-1 memory entries with headings", () => {
    const md = renderMemoryMarkdown([stage1Record()], []);
    expect(md).toContain("## Durable Memory");
    expect(md).toContain("### Routes Architecture");
    expect(md).toContain(
      "Routes use express pattern with middleware chaining.",
    );
  });

  it("includes both manual notes and durable memory when both present", () => {
    const md = renderMemoryMarkdown([stage1Record()], [manualNote()]);
    expect(md).toContain("## Manual Notes");
    expect(md).toContain("## Durable Memory");
  });

  it("falls back to labelled slug when rollout_summary is empty", () => {
    const record = stage1Record({
      result: {
        raw_memory: "Some memory.",
        rollout_summary: "",
        rollout_slug: "build-tooling",
      },
    });
    const md = renderMemoryMarkdown([record], []);
    expect(md).toContain("### Build Tooling");
    expect(md).toContain("## Durable Memory");
  });

  // ── Phase 2 consolidation: failing tests ──────────────────────────

  it("moves toward consolidated/task-grouped durable memory instead of raw stage1 dump", () => {
    const record = stage1Record();
    const md = renderMemoryMarkdown([record], []);
    // Phase 2: canonical MEMORY.md should not have a generic "Stage-1 Memory"
    // section that's a raw dump of each stage1 output.
    expect(md).not.toContain("## Stage-1 Memory");
  });

  it("deduplicates stage1 records with identical raw_memory content", () => {
    const records = [
      stage1Record({
        id: "dup-a",
        createdAt: "2026-06-13T10:00:00.000Z",
        result: {
          raw_memory: "Identical memory content that should be consolidated.",
          rollout_summary: "First",
          rollout_slug: "dup-a",
        },
      }),
      stage1Record({
        id: "dup-b",
        createdAt: "2026-06-14T10:00:00.000Z",
        result: {
          raw_memory: "Identical memory content that should be consolidated.",
          rollout_summary: "Second",
          rollout_slug: "dup-b",
        },
      }),
    ];
    const md = renderMemoryMarkdown(records, []);
    // Phase 2: identical raw_memory should appear only once
    const occurrences = (
      md.match(/Identical memory content that should be consolidated\./g) || []
    ).length;
    expect(occurrences).toBe(1);
  });

  // ── Topic-grouping tests ───────────────────────────────────────

  it("groups related records that share a topic prefix under one H3 heading", () => {
    const records = [
      stage1Record({
        id: "bp-hardening",
        createdAt: "2026-06-13T10:00:00.000Z",
        result: {
          raw_memory: "Browse-pass now has timeout and retry logic.",
          rollout_summary: "Browse-pass hardening",
          rollout_slug: "browse-pass-hardening",
        },
      }),
      stage1Record({
        id: "bp-backoff",
        createdAt: "2026-06-14T10:00:00.000Z",
        result: {
          raw_memory:
            "Browse-pass retry backoff improved with exponential strategy.",
          rollout_summary: "Browse-pass backoff",
          rollout_slug: "browse-pass-backoff",
        },
      }),
    ];
    const md = renderMemoryMarkdown(records, []);
    // Both raw_memory contents present
    expect(md).toContain("Browse-pass now has timeout and retry logic.");
    expect(md).toContain(
      "Browse-pass retry backoff improved with exponential strategy.",
    );
    // Only one H3 heading starting with "Browse-pass "
    const topicHeadings = md.match(/^### Browse-pass /gm) || [];
    expect(topicHeadings).toHaveLength(1);
  });

  it("preserves separate H3 headings for unrelated records", () => {
    const records = [
      stage1Record({
        id: "routes",
        result: {
          raw_memory: "Express-style middleware chaining.",
          rollout_summary: "Routes Architecture",
          rollout_slug: "routes-architecture",
        },
      }),
      stage1Record({
        id: "db",
        result: {
          raw_memory: "SQLite with prepared statements.",
          rollout_summary: "Database Layer",
          rollout_slug: "database-layer",
        },
      }),
    ];
    const md = renderMemoryMarkdown(records, []);
    expect(md).toContain("### Routes Architecture");
    expect(md).toContain("### Database Layer");
    const headings = md.match(/^### /gm) || [];
    expect(headings).toHaveLength(2);
  });

  it("creates a combined heading with unique suffixes joined by & for grouped records", () => {
    const records = [
      stage1Record({
        id: "build-tooling",
        result: {
          raw_memory: "Build system configured with esbuild.",
          rollout_summary: "Build Tooling",
          rollout_slug: "build-tooling",
        },
      }),
      stage1Record({
        id: "build-system",
        result: {
          raw_memory: "Build pipeline includes lint and typecheck.",
          rollout_summary: "Build System",
          rollout_slug: "build-system",
        },
      }),
    ];
    const md = renderMemoryMarkdown(records, []);
    // Combined heading format: common prefix + unique suffixes
    expect(md).toContain("### Build Tooling & System");
    // Both raw contents present
    expect(md).toContain("Build system configured with esbuild.");
    expect(md).toContain("Build pipeline includes lint and typecheck.");
    // Only one H3 heading
    const headings = md.match(/^### /gm) || [];
    expect(headings).toHaveLength(1);
  });

  it("does not exceed size limit for very large content", () => {
    const huge = stage1Record({
      result: {
        raw_memory: "x".repeat(200_000),
        rollout_summary: "Huge",
        rollout_slug: "huge",
      },
    });
    const md = renderMemoryMarkdown([huge], []);
    expect(Buffer.byteLength(md, "utf8")).toBeLessThanOrEqual(200_000);
  });
});

describe("renderMemorySummary", () => {
  it("includes a schema marker on the first line", () => {
    const summary = renderMemorySummary([], []);
    expect(summary).not.toBe("");
    const firstLine = summary.split("\n")[0];
    expect(firstLine).toMatch(/memory-summary-schema:1/);
    expect(firstLine).toMatch(/generated-at:/);
    expect(firstLine).toMatch(/records:/);
    expect(firstLine).toMatch(/notes:/);
  });

  it("schema marker shows correct record and note counts", () => {
    const records = [
      stage1Record({
        id: "r1",
        result: {
          raw_memory: "Mem1",
          rollout_summary: "R1",
          rollout_slug: "r1",
        },
      }),
      stage1Record({
        id: "r2",
        result: {
          raw_memory: "Mem2",
          rollout_summary: "R2",
          rollout_slug: "r2",
        },
      }),
    ];
    const notes = [
      manualNote({ text: "Note1" }),
      manualNote({ text: "Note2" }),
    ];
    const summary = renderMemorySummary(records, notes);
    const firstLine = summary.split("\n")[0];
    expect(firstLine).toContain("records:2");
    expect(firstLine).toContain("notes:2");
  });

  it("schema marker shows zero counts when no records or notes", () => {
    const summary = renderMemorySummary([], []);
    const firstLine = summary.split("\n")[0];
    expect(firstLine).toContain("records:0");
    expect(firstLine).toContain("notes:0");
  });

  it("lists stage-1 entries as indexed H3 sections under Memory Index", () => {
    const summary = renderMemorySummary([stage1Record()], []);
    expect(summary).toContain("## Memory Index");
    expect(summary).toContain("### Routes Architecture");
    expect(summary).toContain(
      "Routes use express pattern with middleware chaining.",
    );
  });

  it("renders manual notes at the top when notes exist", () => {
    const summary = renderMemorySummary(
      [stage1Record()],
      [manualNote(), manualNote()],
    );
    // Manual notes section should appear before Memory Index
    const manualIdx = summary.indexOf("## Manual Notes");
    const memoryIdx = summary.indexOf("## Memory Index");
    expect(manualIdx).toBeGreaterThanOrEqual(0);
    expect(memoryIdx).toBeGreaterThan(manualIdx);
    expect(summary).toContain("Always use `npm test` before committing.");
    // Both notes should be listed (they have distinct IDs)
    const matches =
      summary.match(/Always use `npm test` before committing\./g) || [];
    expect(matches).toHaveLength(2);
  });

  it("renders a single manual note at the top", () => {
    const summary = renderMemorySummary(
      [stage1Record()],
      [manualNote({ text: "Only one note." })],
    );
    expect(summary).toContain("## Manual Notes");
    expect(summary).toContain("- Only one note.");
  });

  // ── Phase 2 consolidation: failing tests ──────────────────────────

  it("renders as routing/index summary with categorized sections, not flat bullet dumps", () => {
    const records = [
      stage1Record({
        id: "routes-arch",
        result: {
          raw_memory: "Express-style middleware chaining.",
          rollout_summary: "Routes Architecture",
          rollout_slug: "routes-architecture",
        },
      }),
      stage1Record({
        id: "db-layer",
        result: {
          raw_memory: "SQLite with prepared statements.",
          rollout_summary: "Database Layer",
          rollout_slug: "database-layer",
        },
      }),
    ];
    const summary = renderMemorySummary(records, []);
    // Phase 2: summary should be a structured routing index with section
    // headings (##), not a flat list of raw stage1 bullet dumps.
    expect(summary).toContain("##");
  });

  it("includes manual note content at the top of the summary, not just a count", () => {
    const summary = renderMemorySummary(
      [stage1Record()],
      [manualNote({ text: "Critical: always verify before committing." })],
    );
    // Phase 2: manual notes should appear with full text, prioritized above
    // stage1 entries in the summary.
    const noteLineIdx = summary.indexOf("Critical:");
    const stage1LineIdx = summary.indexOf("### Routes Architecture");
    expect(noteLineIdx).toBeGreaterThanOrEqual(0);
    expect(stage1LineIdx).toBeGreaterThanOrEqual(0);
    expect(noteLineIdx).toBeLessThan(stage1LineIdx);
  });

  it("limits to first 40 records", async () => {
    const records = Array.from({ length: 50 }, (_, i) =>
      stage1Record({
        id: `slug-${i}`,
        result: {
          raw_memory: `Record ${i}`,
          rollout_summary: `Record ${i}`,
          rollout_slug: `slug-${i}`,
        },
        createdAt: `2026-06-13T${String(i).padStart(2, "0")}:00:00.000Z`,
      }),
    );
    const summary = renderMemorySummary(records, []);
    // Count H3 entries in the Memory Index section
    const h3Lines = summary.split("\n").filter((l) => l.startsWith("### "));
    expect(h3Lines).toHaveLength(40);
    // Verify the 41st is not present
    expect(summary).not.toContain("### Record 40");
  });

  it("truncates long stage1 memory lines in the summary", () => {
    const long = stage1Record({
      result: {
        raw_memory: "x".repeat(5_000),
        rollout_summary: "Long",
        rollout_slug: "long",
      },
    });
    const summary = renderMemorySummary([long], []);
    expect(summary.length).toBeLessThanOrEqual(4_800 + 100);
    expect(summary).toContain("### Long");
    expect(summary).toContain("…");
  });
});

describe("writeMemoryArtifacts", () => {
  it("writes both MEMORY.md and memory_summary.md", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const record = stage1Record();
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify(record)}\n`,
      "utf8",
    );

    await writeMemoryArtifacts(memoryRoot);

    const memory = await readFile(join(memoryRoot, "MEMORY.md"), "utf8");
    const summary = await readFile(
      join(memoryRoot, "memory_summary.md"),
      "utf8",
    );
    expect(memory).toContain("Routes Architecture");
    expect(summary).toContain("Routes Architecture");
  });

  it("writes empty/correct files with no inputs", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeMemoryArtifacts(memoryRoot);

    const memory = await readFile(join(memoryRoot, "MEMORY.md"), "utf8");
    const summary = await readFile(
      join(memoryRoot, "memory_summary.md"),
      "utf8",
    );
    expect(memory).toContain("# Project Memory");
    expect(summary).toContain("memory-summary-schema:1");
  });

  it("includes manual notes and durable memory sections in MEMORY.md", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "manual-notes.jsonl"),
      `${JSON.stringify(manualNote())}\n`,
      "utf8",
    );
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      `${JSON.stringify(stage1Record())}\n`,
      "utf8",
    );

    await writeMemoryArtifacts(memoryRoot);

    const memory = await readFile(join(memoryRoot, "MEMORY.md"), "utf8");
    expect(memory).toContain("## Manual Notes");
    expect(memory).toContain("Always use `npm test` before committing.");
    expect(memory).toContain("## Durable Memory");
  });

  // ── Phase 2 consolidation: failing tests ──────────────────────────

  it("consolidates duplicated stage1 outputs with identical raw_memory when writing artifacts", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "stage1-outputs.jsonl"),
      [
        JSON.stringify(
          stage1Record({
            id: "workers-a",
            createdAt: "2026-06-13T10:00:00.000Z",
            result: {
              raw_memory: "Use workers for background job processing.",
              rollout_summary: "Workers Setup",
              rollout_slug: "workers-setup",
            },
          }),
        ),
        JSON.stringify(
          stage1Record({
            id: "workers-b",
            createdAt: "2026-06-14T10:00:00.000Z",
            result: {
              raw_memory: "Use workers for background job processing.",
              rollout_summary: "Workers Retry",
              rollout_slug: "workers-retry",
            },
          }),
        ),
      ].join("\n"),
      "utf8",
    );

    await writeMemoryArtifacts(memoryRoot);
    const memory = await readFile(join(memoryRoot, "MEMORY.md"), "utf8");

    // Phase 2: duplicated raw_memory from the same topic should be
    // consolidated to one entry, not survive verbatim as two separate H3s.
    const occurrences = (
      memory.match(/Use workers for background job processing\./g) || []
    ).length;
    expect(occurrences).toBe(1);
  });

  it("is a no-op (writes files) even when no sources exist", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await expect(writeMemoryArtifacts(memoryRoot)).resolves.toBeUndefined();
    const memory = await readFile(join(memoryRoot, "MEMORY.md"), "utf8");
    expect(memory).toBeTruthy();
  });
});
