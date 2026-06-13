import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendManualNote,
  readManualNotes,
  type ManualNoteRecord,
} from "../src/manual-notes";

const rootsToCleanup: string[] = [];

async function createMemoryRoot(taskId: string): Promise<string> {
  const dir = join("/tmp", `pi-manual-notes-${process.pid}-${taskId}`);
  rootsToCleanup.push(dir);
  await mkdir(dir, { recursive: true });
  return dir;
}

function fullRecord(
  overrides: Partial<ManualNoteRecord> = {},
): ManualNoteRecord {
  return {
    schemaVersion: 1,
    id: "manual_test",
    createdAt: "2026-06-13T00:00:00.000Z",
    text: "Test manual note",
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

describe("manual-notes", () => {
  it("returns empty array when file does not exist", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await expect(readManualNotes(memoryRoot)).resolves.toEqual([]);
  });

  it("reads and returns written manual notes", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    const id = await appendManualNote(memoryRoot, "First note", "tool");
    const id2 = await appendManualNote(memoryRoot, "Second note", "command");

    const notes = await readManualNotes(memoryRoot);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.text).toBe("First note");
    expect(notes[0]?.source).toBe("tool");
    expect(notes[0]?.id).toBe(id);
    expect(notes[1]?.text).toBe("Second note");
    expect(notes[1]?.source).toBe("command");
    expect(notes[1]?.id).toBe(id2);
  });

  it("skips malformed lines when reading", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "manual-notes.jsonl"),
      `${JSON.stringify(fullRecord({ id: "valid" }))}\nnot json\n${JSON.stringify(fullRecord({ id: "also_valid" }))}\n`,
      "utf8",
    );

    const notes = await readManualNotes(memoryRoot);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.id).toBe("valid");
    expect(notes[1]?.id).toBe("also_valid");
  });

  it("accepts command-sourced notes", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await appendManualNote(memoryRoot, "Command note", "command");

    const notes = await readManualNotes(memoryRoot);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.source).toBe("command");
  });

  it("appends distinct notes while keeping stable order", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await appendManualNote(memoryRoot, "First", "tool", undefined, {
      id: "note_a",
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    await appendManualNote(memoryRoot, "Second", "tool", undefined, {
      id: "note_b",
      createdAt: "2026-06-13T00:00:01.000Z",
    });

    const content = await readFile(
      join(memoryRoot, "manual-notes.jsonl"),
      "utf8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).text).toBe("First");
    expect(JSON.parse(lines[1]!).text).toBe("Second");
  });

  it("upserts a note deterministically when a stable id is provided", async ({
    task,
  }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await appendManualNote(memoryRoot, "Original", "tool", undefined, {
      id: "note_1",
      createdAt: "2026-06-13T00:00:00.000Z",
    });
    await appendManualNote(memoryRoot, "Updated", "tool", undefined, {
      id: "note_1",
      createdAt: "2026-06-13T00:00:00.000Z",
    });

    const notes = await readManualNotes(memoryRoot);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      id: "note_1",
      createdAt: "2026-06-13T00:00:00.000Z",
      text: "Updated",
    });
  });

  it("rejects records with invalid schemaVersion", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "manual-notes.jsonl"),
      JSON.stringify({
        schemaVersion: 2,
        id: "bad",
        createdAt: "",
        text: "",
        source: "tool",
      }) + "\n",
      "utf8",
    );

    await expect(readManualNotes(memoryRoot)).resolves.toHaveLength(0);
  });
});
