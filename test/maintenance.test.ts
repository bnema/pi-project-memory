import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupMemoryMaintenance } from "../src/maintenance";

const rootsToCleanup: string[] = [];

async function createMemoryRoot(taskId: string): Promise<string> {
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-maintenance-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(memoryRoot);
  await mkdir(memoryRoot, { recursive: true });
  return memoryRoot;
}

afterEach(async () => {
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("memory maintenance", () => {
  it("cleans old pending and update logs", async ({ task }) => {
    const memoryRoot = await createMemoryRoot(task.id);
    await writeFile(
      join(memoryRoot, "evidence.jsonl"),
      `${JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ createdAt: "2026-06-01T00:00:00.000Z" })}\n`,
    );
    await writeFile(
      join(memoryRoot, "update-log.jsonl"),
      `${JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );

    expect(
      await cleanupMemoryMaintenance(
        memoryRoot,
        new Date("2026-06-07T00:00:00.000Z"),
        30,
      ),
    ).toBe(2);
    expect(
      await readFile(join(memoryRoot, "evidence.jsonl"), "utf8"),
    ).toContain("2026-06-01");
  });
});
