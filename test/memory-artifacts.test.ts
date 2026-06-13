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

  it("includes stage-1 memory entries with headings", () => {
    const md = renderMemoryMarkdown([stage1Record()], []);
    expect(md).toContain("## Stage-1 Memory");
    expect(md).toContain("### Routes Architecture");
    expect(md).toContain(
      "Routes use express pattern with middleware chaining.",
    );
  });

  it("includes both stage-1 and manual notes when both present", () => {
    const md = renderMemoryMarkdown([stage1Record()], [manualNote()]);
    expect(md).toContain("## Manual Notes");
    expect(md).toContain("## Stage-1 Memory");
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
  it("returns empty string with no records or notes", () => {
    expect(renderMemorySummary([], [])).toBe("");
  });

  it("lists stage-1 entries as bullet points", () => {
    const summary = renderMemorySummary([stage1Record()], []);
    expect(summary).toContain("- Routes Architecture:");
    expect(summary).toContain(
      "Routes use express pattern with middleware chaining.",
    );
  });

  it("appends manual note count when notes exist", () => {
    const summary = renderMemorySummary(
      [stage1Record()],
      [manualNote(), manualNote()],
    );
    expect(summary).toContain("[2 manual notes]");
  });

  it("appends singular manual note count for one note", () => {
    const summary = renderMemorySummary([stage1Record()], [manualNote()]);
    expect(summary).toContain("[1 manual note]");
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
    const lines = summary.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(40);
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
    expect(summary).toContain("- Long:");
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
    expect(summary).toBe("");
  });

  it("includes manual notes in MEMORY.md when manual-notes.jsonl exists", async ({
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
    expect(memory).toContain("## Stage-1 Memory");
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
