import { execFile } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { redactSecrets, truncateUtf8 } from "./events";
import {
  readFacts,
  writeFacts,
  writeMemoryArtifacts,
  type ProjectFact,
} from "./facts";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  pathExists,
  withMemoryLock,
} from "./storage";
import type { ProjectMemoryContext } from "./types";

const execFileAsync = promisify(execFile);
const GIT_STATE_FILE = "git-state.json";
const PENDING_EVENTS_FILE = "pending-events.jsonl";
const UPDATE_LOG_FILE = "update-log.jsonl";
const AUTO_UPDATE_LOG_FILE = "auto-update-log.jsonl";
const DEFAULT_CLEANUP_DAYS = 30;

export interface GitMemoryState {
  schemaVersion: 1;
  lastHead?: string;
  lastCheckedAt: string;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
}

function escapeRegex(input: string): string {
  return input.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  const normalized = normalizePath(glob);
  let pattern = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      pattern += ".*";
      index += 1;
    } else if (char === "*") {
      pattern += "[^/]*";
    } else {
      pattern += escapeRegex(char);
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function stalenessTriggerMatches(
  trigger: string,
  changedPath: string,
  deleted = false,
): boolean {
  const normalizedTrigger = normalizePath(trigger.trim());
  const normalizedPath = normalizePath(changedPath.trim());
  if (!normalizedTrigger || !normalizedPath) return false;
  if (normalizedTrigger.startsWith("deleted:")) {
    return (
      deleted &&
      stalenessTriggerMatches(normalizedTrigger.slice(8), normalizedPath, false)
    );
  }
  if (normalizedTrigger.endsWith("/")) {
    return normalizedPath.startsWith(normalizedTrigger);
  }
  if (normalizedTrigger.includes("*")) {
    return (
      globToRegex(normalizedTrigger).test(normalizedPath) ||
      (normalizedTrigger.startsWith("**/") &&
        globToRegex(normalizedTrigger.slice(3)).test(normalizedPath))
    );
  }
  return (
    normalizedTrigger === normalizedPath ||
    normalizedPath.startsWith(`${normalizedTrigger}/`)
  );
}

export function defaultStalenessTriggers(fact: ProjectFact): string[] {
  const triggers = new Set(fact.stalenessTriggers.map(normalizePath));
  for (const evidence of fact.evidence) {
    if (evidence.path) triggers.add(normalizePath(evidence.path));
  }
  if (fact.kind === "command") {
    for (const trigger of [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "**/*.config.*",
      "**/*test*",
    ]) {
      triggers.add(trigger);
    }
  }
  if (fact.kind === "convention" || fact.kind === "workflow") {
    for (const trigger of ["AGENTS.md", "README.md", "docs/**"])
      triggers.add(trigger);
  }
  if (
    fact.kind === "decision" ||
    fact.kind === "relationship" ||
    fact.topic === "architecture"
  ) {
    triggers.add("src/**");
  }
  return [...triggers].filter(Boolean).sort();
}

export function withDefaultStalenessTriggers(fact: ProjectFact): ProjectFact {
  return { ...fact, stalenessTriggers: defaultStalenessTriggers(fact) };
}

export function markPossiblyStaleFacts(
  facts: ProjectFact[],
  changedPaths: Array<{ path: string; deleted?: boolean }>,
  now = new Date(),
): { facts: ProjectFact[]; marked: number } {
  let marked = 0;
  const next = facts.map((fact) => {
    const withDefaults = withDefaultStalenessTriggers(fact);
    if (withDefaults.status !== "active") return withDefaults;
    const stale = changedPaths.some((changed) =>
      withDefaults.stalenessTriggers.some((trigger) =>
        stalenessTriggerMatches(
          trigger,
          changed.path,
          changed.deleted === true,
        ),
      ),
    );
    if (!stale) return withDefaults;
    marked += 1;
    return {
      ...withDefaults,
      status: "possibly_stale" as const,
      updatedAt: now.toISOString(),
    };
  });
  return { facts: next, marked };
}

export function verifyFacts(
  facts: ProjectFact[],
  ids: string[],
  now = new Date(),
): { facts: ProjectFact[]; verified: number } {
  const selected = new Set(
    ids.length > 0
      ? ids
      : facts
          .filter((fact) => fact.status === "possibly_stale")
          .map((fact) => fact.id),
  );
  let verified = 0;
  const next = facts.map((fact) => {
    if (!selected.has(fact.id)) return fact;
    verified += 1;
    return {
      ...withDefaultStalenessTriggers(fact),
      status: "active" as const,
      updatedAt: now.toISOString(),
      lastVerifiedAt: now.toISOString(),
    };
  });
  return { facts: next, verified };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: 5_000,
      maxBuffer: 200_000,
    });
    return truncateUtf8(redactSecrets(stdout.trim()), 100_000).text;
  } catch {
    return undefined;
  }
}

async function readGitState(
  memoryRoot: string,
): Promise<GitMemoryState | undefined> {
  const path = await assertInsideMemoryRoot(memoryRoot, GIT_STATE_FILE);
  if (!(await pathExists(path))) return undefined;
  try {
    const parsed = JSON.parse(
      await readFile(path, "utf8"),
    ) as Partial<GitMemoryState>;
    if (parsed.schemaVersion !== 1) return undefined;
    return {
      schemaVersion: 1,
      lastHead:
        typeof parsed.lastHead === "string" ? parsed.lastHead : undefined,
      lastCheckedAt:
        typeof parsed.lastCheckedAt === "string"
          ? parsed.lastCheckedAt
          : new Date(0).toISOString(),
    };
  } catch {
    return undefined;
  }
}

async function writeGitState(
  memoryRoot: string,
  state: GitMemoryState,
): Promise<void> {
  const path = await assertInsideMemoryRoot(memoryRoot, GIT_STATE_FILE);
  await atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

export async function markStaleFromGit(
  memory: ProjectMemoryContext,
  cwd: string,
  now = new Date(),
): Promise<{ marked: number; changedPaths: string[] }> {
  return withMemoryLock(memory.memoryRoot, "staleness.lock", async () => {
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    if (!head) return { marked: 0, changedPaths: [] };
    const previous = await readGitState(memory.memoryRoot);
    let changedPaths = "";
    if (previous?.lastHead && previous.lastHead !== head) {
      const diff = await git(cwd, [
        "diff",
        "--name-status",
        previous.lastHead,
        head,
      ]);
      if (diff === undefined) return { marked: 0, changedPaths: [] };
      changedPaths = diff;
    }
    const changed = changedPaths
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [status, ...paths] = line.split(/\s+/);
        const path = paths.at(-1) ?? "";
        return { path, deleted: status === "D" };
      })
      .filter((entry) => entry.path);
    let marked = 0;
    if (changed.length > 0) {
      await withMemoryLock(memory.memoryRoot, "facts.lock", async () => {
        const facts = await readFacts(memory.memoryRoot);
        const result = markPossiblyStaleFacts(facts, changed, now);
        marked = result.marked;
        if (marked > 0) {
          await writeFacts(memory.memoryRoot, result.facts);
          await writeMemoryArtifacts(memory.memoryRoot, result.facts);
        }
      });
    }
    await writeGitState(memory.memoryRoot, {
      schemaVersion: 1,
      lastHead: head,
      lastCheckedAt: now.toISOString(),
    });
    return { marked, changedPaths: changed.map((entry) => entry.path) };
  });
}

async function cleanupJsonlByAge(
  memoryRoot: string,
  relativePath: string,
  cutoffMs: number,
): Promise<number> {
  const path = await assertInsideMemoryRoot(memoryRoot, relativePath);
  if (!(await pathExists(path))) return 0;
  const handle = await open(path, "r");
  let content = "";
  try {
    const chunks: string[] = [];
    let position = 0;
    while (true) {
      const buffer = Buffer.alloc(200_000);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead).toString("utf8"));
      position += bytesRead;
    }
    content = chunks.join("");
  } finally {
    await handle.close();
  }
  const kept: string[] = [];
  let removed = 0;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { createdAt?: unknown };
      const createdAt =
        typeof parsed.createdAt === "string"
          ? Date.parse(parsed.createdAt)
          : NaN;
      if (Number.isFinite(createdAt) && createdAt < cutoffMs) {
        removed += 1;
        continue;
      }
    } catch {
      // Keep malformed lines; other parsers fail closed/skip.
    }
    kept.push(trimmed);
  }
  await atomicWriteFile(path, kept.length > 0 ? `${kept.join("\n")}\n` : "");
  return removed;
}

export async function cleanupMemoryMaintenance(
  memoryRoot: string,
  now = new Date(),
  days = DEFAULT_CLEANUP_DAYS,
): Promise<number> {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  const files: Array<[string, string]> = [
    [PENDING_EVENTS_FILE, "pending-events.lock"],
    [UPDATE_LOG_FILE, "update-log.lock"],
    [AUTO_UPDATE_LOG_FILE, "auto-update.lock"],
  ];
  for (const [file, lock] of files) {
    removed += await withMemoryLock(memoryRoot, lock, () =>
      cleanupJsonlByAge(memoryRoot, file, cutoffMs),
    );
  }
  return removed;
}
