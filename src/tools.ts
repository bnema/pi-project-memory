import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendPendingEvent,
  buildNoteEvent,
  inspectPendingBacklog,
  type PendingBacklogStats,
} from "./events";
import {
  readConsolidationOutcome,
  type ConsolidationState,
} from "./consolidation";
import { readAutoUpdateState, type AutoUpdateState } from "./auto-update";
import { resolveProjectIdentity } from "./project-id";
import {
  assertInsideMemoryRoot,
  memoryRootForProject,
  pathExists,
  readProjectMetadata,
  resolveExistingMemoryContext,
  resolveMemoryContext,
} from "./storage";
import { detectLegacyFiles, type LegacyLayoutReport } from "./legacy";

const DEFAULT_TOOL_OUTPUT_BYTES = 50_000;
const DEFAULT_READ_BYTES = 20_000;
const MAX_READ_BYTES = 50_000;
const MAX_SEARCH_FILE_BYTES = 200_000;
const SEARCH_FILES = [
  "memory_summary.md",
  "MEMORY.md",
  "stage1-outputs.jsonl",
] as const;

function truncateText(
  content: string,
  maxBytes = DEFAULT_TOOL_OUTPUT_BYTES,
): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= maxBytes) return { text: content, truncated: false };
  return {
    text: `${Buffer.from(content, "utf8").subarray(0, Math.max(0, maxBytes)).toString("utf8").trimEnd()}\n\n[truncated]`,
    truncated: true,
  };
}

function clampBytes(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_READ_BYTES;
  return Math.max(1, Math.min(Math.floor(value), MAX_READ_BYTES));
}

async function readTextPrefix(
  path: string,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const cappedBytes = clampBytes(maxBytes);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(cappedBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const truncated = bytesRead > cappedBytes;
    return {
      text: buffer
        .subarray(0, truncated ? cappedBytes : bytesRead)
        .toString("utf8"),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

function textResult(text: string, details: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text }], details };
}

async function currentMemoryRoot(cwd: string): Promise<string | undefined> {
  const context = await resolveExistingMemoryContext(cwd);
  return context?.memoryRoot;
}

export async function readMemoryFile(
  cwd: string,
  relativePath: string,
  maxBytes = DEFAULT_READ_BYTES,
) {
  const memoryRoot = await currentMemoryRoot(cwd);
  if (!memoryRoot) throw new Error("No existing project memory found");
  const safePath = await assertInsideMemoryRoot(memoryRoot, relativePath);
  const content = await readTextPrefix(safePath, maxBytes);
  return { path: relativePath, ...content };
}

export async function searchMemory(
  cwd: string,
  query: string,
  maxResults = 20,
) {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) throw new Error("Search query must not be empty");

  const memoryRoot = await currentMemoryRoot(cwd);
  if (!memoryRoot) throw new Error("No existing project memory found");

  const matches: Array<{ file: string; line: number; text: string }> = [];
  for (const file of SEARCH_FILES) {
    const safePath = await assertInsideMemoryRoot(memoryRoot, file);
    if (!(await pathExists(safePath))) continue;
    const { text: content } = await readTextPrefix(
      safePath,
      MAX_SEARCH_FILE_BYTES,
    );
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.toLowerCase().includes(trimmed)) {
        matches.push({
          file,
          line: index + 1,
          text: truncateText(line, 500).text,
        });
        if (matches.length >= maxResults) return matches;
      }
    }
  }
  return matches;
}

export async function memoryStatus(cwd: string) {
  const identity = await resolveProjectIdentity(cwd);
  if (!identity) return "No Git repository found for project memory.";
  const memoryRoot = memoryRootForProject(
    identity.projectId,
    undefined,
    identity.scope,
  );
  const metadata = await readProjectMetadata(memoryRoot);

  const files = await Promise.all(
    SEARCH_FILES.map(async (file) => ({
      file,
      exists: await pathExists(join(memoryRoot, file)),
    })),
  );

  let backlog: PendingBacklogStats = {
    evidence: {
      count: 0,
      bytes: 0,
      malformedLines: 0,
      oldestCreatedAt: undefined,
      newestCreatedAt: undefined,
      nearReadLimit: false,
      overReadLimit: false,
    },
    notes: {
      count: 0,
      bytes: 0,
      malformedLines: 0,
      oldestCreatedAt: undefined,
      newestCreatedAt: undefined,
      nearReadLimit: false,
      overReadLimit: false,
    },
    totalCount: 0,
    totalBytes: 0,
  };
  let legacy: LegacyLayoutReport = {
    hasOldFactsFile: false,
    hasLegacyPendingEventsFile: false,
    hasLegacyGitStateFile: false,
    hasUnversionedSummary: false,
    hasStage1Outputs: false,
    hasManualNotes: false,
    legacyFiles: [],
    isLegacy: false,
    isMixedLayout: false,
  };
  let outcome: ConsolidationState | undefined;
  let autoState: AutoUpdateState = { schemaVersion: 1, enabled: true };
  let inspectionWarning: string | undefined;
  try {
    [backlog, legacy, outcome, autoState] = await Promise.all([
      inspectPendingBacklog(memoryRoot),
      detectLegacyFiles(memoryRoot),
      readConsolidationOutcome(memoryRoot),
      readAutoUpdateState(memoryRoot),
    ]);
  } catch (error) {
    inspectionWarning = error instanceof Error ? error.message : String(error);
  }

  const lines = [
    `Project memory: ${memoryRoot}`,
    `Project id: ${identity.projectId}`,
    `Scope: ${identity.scope}`,
    `Canonical source: ${identity.canonicalSource}`,
  ];
  if (identity.warning) lines.push(`Warning: ${identity.warning}`);
  if (inspectionWarning) {
    lines.push(
      `Warning: project memory inspection incomplete: ${inspectionWarning}`,
    );
  }
  if (metadata) {
    lines.push(
      `Aliases: ${metadata.aliases.length}`,
      `Seen roots: ${metadata.seenRoots.length}`,
      `Pending events: ${backlog.totalCount} (evidence=${backlog.evidence.count}, notes=${backlog.notes.count})`,
      `Pending bytes: ${backlog.totalBytes} (evidence=${backlog.evidence.bytes}, notes=${backlog.notes.bytes})`,
    );
    if (backlog.evidence.oldestCreatedAt || backlog.notes.oldestCreatedAt) {
      const oldestCandidates = [
        backlog.evidence.oldestCreatedAt,
        backlog.notes.oldestCreatedAt,
      ].filter(Boolean) as string[];
      const oldest = oldestCandidates.sort()[0];
      if (oldest) lines.push(`Pending oldest: ${oldest}`);
    }
    if (backlog.evidence.newestCreatedAt || backlog.notes.newestCreatedAt) {
      const newestCandidates = [
        backlog.evidence.newestCreatedAt,
        backlog.notes.newestCreatedAt,
      ].filter(Boolean) as string[];
      const newest = newestCandidates.sort().at(-1);
      if (newest) lines.push(`Pending newest: ${newest}`);
    }
    if (
      backlog.evidence.malformedLines > 0 ||
      backlog.notes.malformedLines > 0
    ) {
      lines.push(
        `Pending malformed lines: evidence=${backlog.evidence.malformedLines}, notes=${backlog.notes.malformedLines}`,
      );
    }
    if (backlog.evidence.overReadLimit || backlog.notes.overReadLimit) {
      lines.push("Pending backlog status: over read limit");
    } else if (backlog.evidence.nearReadLimit || backlog.notes.nearReadLimit) {
      lines.push("Pending backlog status: near read limit");
    }

    if (outcome?.lastOutcome) {
      lines.push(
        `Last consolidation: ${outcome.lastOutcome.mode} (applied ${outcome.lastOutcome.applied})`,
        `Last consolidation at: ${outcome.lastOutcome.at}`,
      );
    }

    if (autoState.lastSkipReason) {
      lines.push(`Last auto-update skip: ${autoState.lastSkipReason}`);
    }
  } else {
    lines.push("Metadata: not initialized");
  }
  if (legacy.isLegacy) {
    lines.push(
      `Legacy layout: ${legacy.legacyFiles.join(", ")}${legacy.isMixedLayout ? " (mixed current + legacy)" : ""}`,
    );
  }
  lines.push(
    `Files: ${files.map(({ file, exists }) => `${basename(file)}=${exists ? "yes" : "no"}`).join(", ")}`,
  );
  return lines.join("\n");
}

export function registerProjectMemoryTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "project_memory_status",
    label: "Project Memory Status",
    description:
      "Show project-memory identity, storage path, and available memory files for the current Git project.",
    promptSnippet: "Show project memory status for the current Git project",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      return textResult(await memoryStatus(ctx.cwd));
    },
  });

  pi.registerTool({
    name: "project_memory_read",
    label: "Project Memory Read",
    description:
      "Read a project-memory file by safe relative path. Output is truncated.",
    promptSnippet: "Read a project memory file by safe relative path",
    parameters: Type.Object({
      path: Type.String({
        description: "Safe relative path inside the project memory root",
      }),
      maxBytes: Type.Optional(
        Type.Number({
          description: "Maximum bytes to return",
          minimum: 1,
          maximum: MAX_READ_BYTES,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await readMemoryFile(
        ctx.cwd,
        params.path,
        params.maxBytes ?? DEFAULT_READ_BYTES,
      );
      return textResult(result.text, {
        path: result.path,
        truncated: result.truncated,
      });
    },
  });

  pi.registerTool({
    name: "project_memory_note",
    label: "Project Memory Note",
    description:
      "Add an explicit user-approved note to pending project memory events. Does not call a model or update generated memory files.",
    promptSnippet:
      "Add an explicit user-approved note to pending project memory",
    parameters: Type.Object({
      note: Type.String({
        description: "Explicit project memory note approved by the user",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const memoryContext = await resolveMemoryContext(ctx.cwd);
      if (!memoryContext)
        throw new Error("No Git repository found for project memory");
      const event = buildNoteEvent(params.note, "tool");
      await appendPendingEvent(memoryContext, event);
      return textResult(`Stored pending project memory note: ${event.id}`, {
        eventId: event.id,
        kind: event.kind,
      });
    },
  });

  pi.registerTool({
    name: "project_memory_search",
    label: "Project Memory Search",
    description:
      "Search MEMORY.md, memory_summary.md, and stored extraction records for a keyword. Output is bounded.",
    promptSnippet:
      "Search project memory for architecture, conventions, commands, and landmines",
    parameters: Type.Object({
      query: Type.String({
        description: "Case-insensitive substring to search for",
      }),
      maxResults: Type.Optional(
        Type.Number({
          description: "Maximum number of matching lines",
          minimum: 1,
          maximum: 100,
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const matches = await searchMemory(
        ctx.cwd,
        params.query,
        Math.min(params.maxResults ?? 20, 100),
      );
      if (matches.length === 0)
        return textResult("No project memory matches found.", { matches: 0 });
      const text = matches
        .map((match) => `${match.file}:${match.line}: ${match.text}`)
        .join("\n");
      return textResult(text, { matches: matches.length });
    },
  });
}
