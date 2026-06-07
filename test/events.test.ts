import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendPendingEvent,
  buildCheckpointEvent,
  buildNoteEvent,
  extractCommandStrings,
  extractLatestAssistantSummary,
  extractLatestUserObjective,
  redactSecrets,
  truncateUtf8,
} from "../src/events";
import { resolveMemoryContext } from "../src/storage";

const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string) {
  const repo = join(
    "/tmp",
    `pi-project-memory-events-repo-${process.pid}-${taskId}`,
  );
  const memoryRoot = join(
    "/tmp",
    `pi-project-memory-events-store-${process.pid}-${taskId}`,
  );
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
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

describe("pending project memory events", () => {
  it("redacts and truncates explicit notes before appending JSONL", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    const event = buildNoteEvent(
      `remember token=super-secret ${"x".repeat(5_000)}`,
      "tool",
      new Date("2026-06-07T00:00:00.000Z"),
    );
    await appendPendingEvent(context, event);

    const jsonl = await readFile(
      join(context.memoryRoot, "pending-events.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain("[REDACTED]");
    expect(jsonl).not.toContain("super-secret");
    expect(JSON.parse(jsonl).text.length).toBeLessThanOrEqual(4_000);
  });

  it("extracts objective and bounded command strings from session entries", async ({
    task,
  }) => {
    const { repo } = await createRepo(task.id);
    const entries = [
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "Explore architecture" }],
        },
      },
      {
        message: {
          role: "toolResult",
          toolName: "bash",
          details: { command: "npm test" },
        },
      },
      {
        message: {
          role: "bashExecution",
          command: "npm run check",
        },
      },
    ];

    expect(extractLatestUserObjective(entries)).toBe("Explore architecture");
    const event = await buildCheckpointEvent(
      repo,
      { sessionManager: { getBranch: () => entries } },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    expect(event.objective).toBe("Explore architecture");
    expect(event.commands).toEqual(["npm test", "npm run check"]);
    expect(extractCommandStrings(entries)).toEqual([
      "npm test",
      "npm run check",
    ]);
  });

  it("captures the latest assistant summary in checkpoint events", async ({
    task,
  }) => {
    const { repo } = await createRepo(task.id);
    const entries = [
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Le sous-agent a terminé. Architecture: Astro SSR. token=secret",
            },
          ],
        },
      },
    ];

    expect(extractLatestAssistantSummary(entries)).toContain(
      "Le sous-agent a terminé",
    );
    const event = await buildCheckpointEvent(
      repo,
      { sessionManager: { getBranch: () => entries } },
      new Date("2026-06-07T00:00:00.000Z"),
    );
    expect(event.assistantSummary).toContain("Architecture: Astro SSR");
    expect(event.assistantSummary).not.toContain("secret");
  });

  it("keeps UTF-8 truncation within byte caps", () => {
    const truncated = truncateUtf8("€".repeat(2_000), 4_000);
    expect(truncated.truncated).toBe(true);
    expect(Buffer.byteLength(truncated.text, "utf8")).toBeLessThanOrEqual(
      4_000,
    );
  });

  it("redacts common secret patterns", () => {
    expect(
      redactSecrets("password=hunter2 Authorization: Bearer abc.def"),
    ).toContain("password=[REDACTED]");
    expect(redactSecrets("Bearer abc.def")).toContain("Bearer [REDACTED]");
    expect(redactSecrets('{"token":"secret"}')).not.toContain("secret");
    expect(redactSecrets('apiKey = "secret"')).not.toContain("secret");
    expect(redactSecrets('token: "secret"')).not.toContain("secret");
    expect(redactSecrets('password="my secret"')).not.toContain("my secret");
  });
});
