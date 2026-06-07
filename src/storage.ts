import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { resolveProjectIdentity } from "./project-id";
import type {
  ProjectIdentity,
  ProjectMemoryContext,
  ProjectMetadata,
} from "./types";

export interface StorageOptions {
  root?: string;
  now?: () => Date;
}

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LOCK_WAIT_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;

export function defaultStorageRoot(): string {
  return (
    process.env.PI_PROJECT_MEMORY_ROOT ??
    join(homedir(), ".pi", "agent", "project-memory")
  );
}

export function memoryRootForProject(
  projectId: string,
  storageRoot = defaultStorageRoot(),
): string {
  if (!/^[a-f0-9]{64}$/.test(projectId)) {
    throw new Error("Project id must be a lowercase sha256 hex digest");
  }
  return join(storageRoot, "by-remote", projectId);
}

export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function atomicWriteFile(
  path: string,
  content: string,
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const tempPath = join(
    dirname(path),
    `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, "w", PRIVATE_FILE_MODE);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = undefined;
    await rename(tempPath, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function parseProjectMetadata(content: string): ProjectMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new Error("Invalid project metadata JSON");
  }
  if (!parsed || typeof parsed !== "object")
    throw new Error("Invalid project metadata");
  const metadata = parsed as Record<string, unknown>;
  if (
    typeof metadata.projectId !== "string" ||
    typeof metadata.canonicalRemote !== "string" ||
    (metadata.scope !== "git-remote" && metadata.scope !== "path") ||
    !isStringArray(metadata.aliases) ||
    !isStringArray(metadata.seenRoots) ||
    typeof metadata.createdAt !== "string" ||
    typeof metadata.lastSeenAt !== "string"
  ) {
    throw new Error("Invalid project metadata");
  }

  return metadata as unknown as ProjectMetadata;
}

export async function readProjectMetadata(
  memoryRoot: string,
): Promise<ProjectMetadata | undefined> {
  const metadataPath = join(memoryRoot, "project.json");
  if (!(await pathExists(metadataPath))) return undefined;
  return parseProjectMetadata(await readFile(metadataPath, "utf8"));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export function buildProjectMetadata(
  identity: ProjectIdentity,
  existing: ProjectMetadata | undefined,
  now = new Date(),
): ProjectMetadata {
  const timestamp = now.toISOString();
  const aliases = identity.remoteUrl
    ? uniqueSorted([...(existing?.aliases ?? []), identity.remoteUrl])
    : (existing?.aliases ?? []);
  const seenRoots = uniqueSorted([
    ...(existing?.seenRoots ?? []),
    identity.gitRoot,
  ]);

  return {
    projectId: identity.projectId,
    canonicalRemote: identity.canonicalSource,
    scope: identity.scope,
    aliases,
    seenRoots,
    createdAt: existing?.createdAt ?? timestamp,
    lastSeenAt: timestamp,
  };
}

export async function writeProjectMetadata(
  memoryRoot: string,
  metadata: ProjectMetadata,
): Promise<void> {
  await atomicWriteFile(
    join(memoryRoot, "project.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
}

export async function initializeMemoryStorage(
  identity: ProjectIdentity,
  options: StorageOptions = {},
): Promise<ProjectMemoryContext> {
  const memoryRoot = memoryRootForProject(identity.projectId, options.root);
  await ensurePrivateDir(memoryRoot);
  await ensurePrivateDir(join(memoryRoot, "locks"));

  return withMemoryLock(memoryRoot, "project-json.lock", async () => {
    const existing = await readProjectMetadata(memoryRoot);
    const metadata = buildProjectMetadata(
      identity,
      existing,
      options.now?.() ?? new Date(),
    );
    await writeProjectMetadata(memoryRoot, metadata);
    return { identity, memoryRoot, metadata };
  });
}

export async function resolveMemoryContext(
  cwd: string,
  options: StorageOptions = {},
): Promise<ProjectMemoryContext | undefined> {
  const identity = await resolveProjectIdentity(cwd);
  if (!identity) return undefined;
  return initializeMemoryStorage(identity, options);
}

export async function withMemoryLock<T>(
  memoryRoot: string,
  lockName: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (
    !/^[A-Za-z0-9._-]+$/.test(lockName) ||
    lockName === "." ||
    lockName === ".."
  ) {
    throw new Error("Lock name must be a safe basename");
  }

  const locksRoot = join(memoryRoot, "locks");
  await ensurePrivateDir(locksRoot);
  const lockPath = join(locksRoot, lockName);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
      break;
    } catch (error) {
      if (
        !isNodeError(error) ||
        error.code !== "EEXIST" ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      await sleep(LOCK_RETRY_MS);
    }
  }

  try {
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function assertInsideMemoryRoot(
  memoryRoot: string,
  relativePath: string,
): Promise<string> {
  if (relativePath.startsWith("/") || relativePath.includes("\0")) {
    throw new Error("Memory path must be a safe relative path");
  }

  const root = await realpath(memoryRoot);
  const candidate = resolve(root, relativePath);
  const existingParent = (await pathExists(candidate))
    ? candidate
    : dirname(candidate);
  const realParent = await realpath(existingParent);

  if (realParent !== root && !realParent.startsWith(`${root}/`)) {
    throw new Error("Memory path escapes project memory root");
  }

  return candidate;
}
