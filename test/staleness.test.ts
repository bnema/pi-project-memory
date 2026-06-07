import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  readFacts,
  renderMemorySummary,
  writeFacts,
  type ProjectFact,
} from "../src/facts";
import { resolveMemoryContext } from "../src/storage";
import {
  cleanupMemoryMaintenance,
  defaultStalenessTriggers,
  markPossiblyStaleFacts,
  markStaleFromGit,
  stalenessTriggerMatches,
  verifyFacts,
} from "../src/staleness";

const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function fact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  return {
    schemaVersion: 1,
    id: "fact_one",
    kind: "observation",
    topic: "architecture",
    scope: "whole_project",
    text: "Architecture fact",
    evidence: [{ type: "file", path: "src/app.ts", note: "source" }],
    confidence: "verified",
    status: "active",
    stalenessTriggers: [],
    sourceEventIds: ["event_one"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

async function createRepo(taskId: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-stale-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-stale-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["config", "user.email", "test@example.invalid"], repo);
  await git(["config", "user.name", "Test User"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "app.ts"), "one");
  await git(["add", "."], repo);
  await git(["commit", "-m", "initial"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = await resolveMemoryContext(repo);
  if (!context) throw new Error("expected memory context");
  return { repo, context };
}

afterEach(async () => {
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("staleness", () => {
  it("matches exact, directory, glob, and deleted triggers", () => {
    expect(stalenessTriggerMatches("src/app.ts", "src/app.ts")).toBe(true);
    expect(stalenessTriggerMatches("src/", "src/app.ts")).toBe(true);
    expect(stalenessTriggerMatches("**/*.config.*", "vitest.config.ts")).toBe(
      true,
    );
    expect(
      stalenessTriggerMatches("deleted:src/app.ts", "src/app.ts", true),
    ).toBe(true);
    expect(
      stalenessTriggerMatches("deleted:src/app.ts", "src/app.ts", false),
    ).toBe(false);
  });

  it("adds default triggers from evidence and kind/topic", () => {
    expect(
      defaultStalenessTriggers(fact({ kind: "command", topic: "tooling" })),
    ).toEqual(
      expect.arrayContaining(["src/app.ts", "package.json", "**/*.config.*"]),
    );
  });

  it("marks stale facts and excludes them from summary", () => {
    const result = markPossiblyStaleFacts(
      [fact()],
      [{ path: "src/app.ts" }],
      new Date("2026-06-08T00:00:00.000Z"),
    );
    expect(result.marked).toBe(1);
    expect(result.facts[0]?.status).toBe("possibly_stale");
    const summary = renderMemorySummary(result.facts);
    expect(summary).not.toContain("Architecture fact");
    expect(summary).toContain("possibly stale facts excluded");
  });

  it("verifies stale facts", () => {
    const stale = fact({ status: "possibly_stale" });
    const result = verifyFacts(
      [stale],
      [],
      new Date("2026-06-09T00:00:00.000Z"),
    );
    expect(result.verified).toBe(1);
    expect(result.facts[0]?.status).toBe("active");
    expect(result.facts[0]?.lastVerifiedAt).toBe("2026-06-09T00:00:00.000Z");
  });

  it("detects git changes since last seen head", async ({ task }) => {
    const { repo, context } = await createRepo(task.id);
    await writeFacts(context.memoryRoot, [fact()]);
    await markStaleFromGit(context, repo, new Date("2026-06-07T00:00:00.000Z"));

    await writeFile(join(repo, "src", "app.ts"), "two");
    await git(["add", "."], repo);
    await git(["commit", "-m", "change app"], repo);
    const result = await markStaleFromGit(
      context,
      repo,
      new Date("2026-06-08T00:00:00.000Z"),
    );

    expect(result.marked).toBe(1);
    expect((await readFacts(context.memoryRoot))[0]?.status).toBe(
      "possibly_stale",
    );
  });

  it("cleans old pending and update logs", async ({ task }) => {
    const { context } = await createRepo(task.id);
    await writeFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      `${JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" })}\n${JSON.stringify({ createdAt: "2026-06-01T00:00:00.000Z" })}\n`,
    );
    await writeFile(
      join(context.memoryRoot, "update-log.jsonl"),
      `${JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z" })}\n`,
    );

    expect(
      await cleanupMemoryMaintenance(
        context.memoryRoot,
        new Date("2026-06-07T00:00:00.000Z"),
        30,
      ),
    ).toBe(2);
    expect(
      await readFile(join(context.memoryRoot, "pending-events.jsonl"), "utf8"),
    ).toContain("2026-06-01");
  });
});
