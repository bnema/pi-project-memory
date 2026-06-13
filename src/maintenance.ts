import { open } from "node:fs/promises";
import {
  assertInsideMemoryRoot,
  atomicWriteFile,
  pathExists,
  withMemoryLock,
} from "./storage";

const EVIDENCE_FILE = "evidence.jsonl";
const UPDATE_LOG_FILE = "update-log.jsonl";
const AUTO_UPDATE_LOG_FILE = "auto-update-log.jsonl";
const DEFAULT_CLEANUP_DAYS = 30;

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
    [EVIDENCE_FILE, "pending-events.lock"],
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
