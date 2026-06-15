import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendPendingEvent,
  buildEvidenceEvent,
  buildNoteEvent,
  extractCommandStrings,
  extractLatestUserObjective,
  inspectPendingBacklog,
  redactSecrets,
  truncateUtf8,
} from "../src/events";
import { extractSessionEvidence, isUsefulEvidence } from "../src/evidence";
import type { SessionEvidenceItem } from "../src/evidence";
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
      join(context.memoryRoot, "trusted-notes.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain("[REDACTED]");
    expect(jsonl).not.toContain("super-secret");
    expect(JSON.parse(jsonl).text.length).toBeLessThanOrEqual(4_000);
  });

  it("bounds retained checkpoint backlog while preserving explicit notes", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    const note = buildNoteEvent("keep explicit note", "tool");
    await appendPendingEvent(context, note);

    for (let index = 0; index < 30; index += 1) {
      await appendPendingEvent(context, {
        schemaVersion: 1,
        id: `evidence_${index}`,
        kind: "evidence",
        source: "command",
        createdAt: new Date(index).toISOString(),
        evidence: [{ type: "assistant", content: `summary ${index}` }],
        changedFilesStatTruncated: false,
        commands: [],
      });
    }

    const evidenceLines = (
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; kind: string });
    const notesLines = (
      await readFile(join(context.memoryRoot, "trusted-notes.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; kind: string });

    expect(
      evidenceLines.filter((event) => event.kind === "evidence"),
    ).toHaveLength(25);
    expect(notesLines.map((event) => event.id)).toContain(note.id);
    expect(evidenceLines.map((event) => event.id)).not.toContain("evidence_0");
    expect(evidenceLines.map((event) => event.id)).toContain("evidence_29");
  });

  it("bounds checkpoint entries even when checkpoint ids repeat", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    for (let index = 0; index < 30; index += 1) {
      await appendPendingEvent(context, {
        schemaVersion: 1,
        id: "same_evidence_id",
        kind: "evidence",
        source: "command",
        createdAt: new Date(index).toISOString(),
        evidence: [{ type: "assistant", content: `summary ${index}` }],
        changedFilesStatTruncated: false,
        commands: [],
      });
    }

    const events = (
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { evidence?: SessionEvidenceItem[] });

    expect(events).toHaveLength(25);
    expect(events[0]?.evidence?.[0]?.content).toBe("summary 5");
    expect(events.at(-1)?.evidence?.[0]?.content).toBe("summary 29");
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
    const event = await buildEvidenceEvent(
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

  it("extracts objective and commands from raw agent_end message objects", () => {
    const entries = [
      {
        role: "user",
        content: [{ type: "text", text: "Explore runtime behavior" }],
      },
      {
        role: "bashExecution",
        command: "npm run lint",
      },
      {
        toolName: "bash",
        details: { command: "npm test" },
      },
    ];

    expect(extractLatestUserObjective(entries)).toBe(
      "Explore runtime behavior",
    );
    expect(extractCommandStrings(entries)).toEqual([
      "npm run lint",
      "npm test",
    ]);
    expect(extractSessionEvidence(entries)).toEqual([
      {
        type: "user",
        content: "Explore runtime behavior",
      },
      {
        type: "bash",
        content: "npm run lint",
        source: "npm run lint",
      },
      {
        type: "bash",
        content: "npm test",
        source: "npm test",
      },
    ]);
  });

  it("extracts filtered evidence with redacted secrets from session entries", async ({
    task,
  }) => {
    const { repo } = await createRepo(task.id);
    const entries = [
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "Explore the project architecture" }],
        },
      },
      {
        message: {
          role: "bashExecution",
          command: "npm test",
        },
      },
      {
        message: {
          role: "toolResult",
          toolName: "read",
          content: [{ type: "text", text: "# README\nProject structure" }],
        },
      },
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Architecture: Astro SSR. token=secret",
            },
          ],
        },
      },
      {
        message: {
          role: "system",
          content: [{ type: "text", text: "You are a helpful assistant" }],
        },
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];

    const event = await buildEvidenceEvent(
      repo,
      { sessionManager: { getBranch: () => entries } },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(event.evidence).toBeDefined();
    expect(event.evidence).toHaveLength(4);

    const userEvidence = event.evidence!.find((e) => e.type === "user");
    expect(userEvidence?.content).toContain("Explore the project");

    const bashEvidence = event.evidence!.find((e) => e.type === "bash");
    expect(bashEvidence?.content).toContain("npm test");

    const toolEvidence = event.evidence!.find((e) => e.type === "tool");
    expect(toolEvidence?.content).toContain("Project structure");

    const assistantEvidence = event.evidence!.find(
      (e) => e.type === "assistant",
    );
    expect(assistantEvidence?.content).toContain("Architecture: Astro SSR");
    expect(assistantEvidence?.content).not.toContain("secret");

    // System messages and low-value "ok" should be excluded
    const hasSystem = event.evidence!.some((e) =>
      e.content.includes("helpful"),
    );
    expect(hasSystem).toBe(false);
    const hasOk = event.evidence!.some((e) => e.content === "ok");
    expect(hasOk).toBe(false);

    // The evidence event should use evidence items instead of a free-form assistant summary
    expect(event.evidence!.length).toBeGreaterThan(0);
  });

  it("extracts evidence from bash tool results with command extraction", async ({
    task,
  }) => {
    const { repo } = await createRepo(task.id);
    const entries = [
      {
        message: {
          role: "toolResult",
          toolName: "bash",
          details: { command: "rtk cargo build" },
        },
      },
      {
        message: {
          role: "toolResult",
          toolName: "bash",
          details: { command: "rtk npm test" },
        },
      },
    ];

    const event = await buildEvidenceEvent(
      repo,
      { sessionManager: { getBranch: () => entries } },
      new Date("2026-06-07T00:00:00.000Z"),
    );

    expect(event.evidence).toBeDefined();
    const bashEvidence = event.evidence!.filter((e) => e.type === "bash");
    expect(bashEvidence).toHaveLength(2);
    expect(bashEvidence[0]?.content).toContain("rtk cargo build");
    expect(bashEvidence[1]?.content).toContain("rtk npm test");
  });

  it("extracts evidence directly with redaction and filtering", () => {
    const entries = [
      {
        message: {
          role: "user",
          content: [{ type: "text", text: "Check the API design" }],
        },
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "API uses REST. token=secret" }],
        },
      },
      {
        message: {
          role: "system",
          content: [{ type: "text", text: "You are a coding agent" }],
        },
      },
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];

    const evidence = extractSessionEvidence(entries);

    expect(evidence).toHaveLength(2);
    expect(evidence[0]?.type).toBe("user");
    expect(evidence[0]?.content).toContain("API design");
    expect(evidence[1]?.type).toBe("assistant");
    expect(evidence[1]?.content).toContain("REST");
    expect(evidence[1]?.content).not.toContain("secret");
  });

  it("filters out low-value and empty evidence", () => {
    expect(isUsefulEvidence("Explore architecture")).toBe(true);
    expect(isUsefulEvidence("Remember npm test")).toBe(true);
    expect(isUsefulEvidence("ok")).toBe(false);
    expect(isUsefulEvidence("done")).toBe(false);
    expect(isUsefulEvidence("continue")).toBe(false);
    expect(isUsefulEvidence("sounds good")).toBe(false);
    expect(isUsefulEvidence("")).toBe(false);
    expect(isUsefulEvidence("  ")).toBe(false);
    expect(isUsefulEvidence("!?")).toBe(false);
    expect(isUsefulEvidence("I'll implement that")).toBe(true);
    expect(isUsefulEvidence("Let me check the code")).toBe(true);
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

  it("inspects pending backlog bytes, timestamps, and malformed lines", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);
    await appendPendingEvent(
      context,
      buildNoteEvent(
        "remember the manual note",
        "tool",
        new Date("2026-06-07T00:00:00.000Z"),
      ),
    );
    await writeFile(
      join(context.memoryRoot, "evidence.jsonl"),
      [
        JSON.stringify({
          schemaVersion: 1,
          id: "evidence_a",
          kind: "evidence",
          source: "command",
          createdAt: "2026-06-07T01:00:00.000Z",
          evidence: [{ type: "assistant", content: "alpha" }],
          changedFilesStatTruncated: false,
          commands: [],
        }),
        "{not json}",
        JSON.stringify({
          schemaVersion: 1,
          id: "evidence_b",
          kind: "evidence",
          source: "command",
          createdAt: "2026-06-07T02:00:00.000Z",
          evidence: [{ type: "assistant", content: "beta" }],
          changedFilesStatTruncated: false,
          commands: [],
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const backlog = await inspectPendingBacklog(context.memoryRoot);
    expect(backlog.totalCount).toBe(3);
    expect(backlog.evidence.count).toBe(2);
    expect(backlog.notes.count).toBe(1);
    expect(backlog.evidence.malformedLines).toBe(1);
    expect(backlog.evidence.oldestCreatedAt).toBe("2026-06-07T01:00:00.000Z");
    expect(backlog.evidence.newestCreatedAt).toBe("2026-06-07T02:00:00.000Z");
    expect(backlog.totalBytes).toBeGreaterThan(0);
  });

  it("prunes oversized evidence backlog by byte size when count alone is insufficient", async ({
    task,
  }) => {
    const { context } = await createRepo(task.id);

    // Create a few very large evidence events. Count is well under 25,
    // but total byte size exceeds the pruning target (400KB).
    for (let i = 0; i < 6; i++) {
      await appendPendingEvent(context, {
        schemaVersion: 1,
        id: `huge_${i}`,
        kind: "evidence",
        source: "command",
        createdAt: new Date(i).toISOString(),
        evidence: Array.from({ length: 20 }, (_, j) => ({
          type: "assistant" as const,
          content: `Ev${i}_${j}: ` + "X".repeat(5_000),
        })),
        changedFilesStatTruncated: false,
        commands: [],
      });
    }

    const evidenceContent = await readFile(
      join(context.memoryRoot, "evidence.jsonl"),
      "utf8",
    );

    // File must be under the 500KB read limit after byte-aware pruning
    const fileBytes = Buffer.byteLength(evidenceContent, "utf8");
    expect(fileBytes).toBeLessThan(500_000);

    const events = evidenceContent
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; kind: string });
    expect(events.some((event) => event.kind === "evidence")).toBe(true);
    expect(events.map((event) => event.id)).toContain("huge_5");
    expect(events.map((event) => event.id)).not.toContain("huge_0");
  });

  it("prefers recent high-signal evidence over oldest-first truncation", () => {
    // Fill the buffer with 30 useful but routine entries
    const entries: unknown[] = [];
    for (let i = 0; i < 30; i++) {
      entries.push({
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Routine checkpoint number ${i}.` }],
        },
      });
    }
    // Add one more recent, high-signal item
    entries.push({
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Architecture: switched from Express to Hono for better performance.",
          },
        ],
      },
    });

    const evidence = extractSessionEvidence(entries);

    // The recent high-signal item should survive — it should not be
    // silently dropped just because the first-30-items buffer filled up.
    expect(evidence.some((e) => e.content.includes("Architecture"))).toBe(true);
    // Total should still respect the limit
    expect(evidence.length).toBeLessThanOrEqual(30);
  });
});
