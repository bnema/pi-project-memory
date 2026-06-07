import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
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
const LOCK_STALE_MS = 60_000;
const MAX_METADATA_BYTES = 100_000;

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

async function assertNotSymlink(path: string, label: string): Promise<void> {
  if (!(await pathExists(path))) return;
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
}

async function ensureSafeDir(path: string, label: string): Promise<void> {
  await assertNotSymlink(path, label);
  await ensurePrivateDir(path);
  await assertNotSymlink(path, label);
}

async function assertChildRealpath(
  parent: string,
  child: string,
  label: string,
): Promise<void> {
  const parentReal = await realpath(parent);
  const childReal = await realpath(child);
  if (childReal !== parentReal && !childReal.startsWith(`${parentReal}/`)) {
    throw new Error(`${label} escapes storage root`);
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

async function readUtf8FileBounded(
  path: string,
  maxBytes: number,
): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes)
      throw new Error("Project metadata exceeds size limit");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function validateExistingMemoryRoot(
  storageRoot: string,
  memoryRoot: string,
): Promise<boolean> {
  const byRemoteRoot = join(storageRoot, "by-remote");
  if (!(await pathExists(memoryRoot))) return false;
  await assertNotSymlink(storageRoot, "Project memory storage root");
  await assertNotSymlink(byRemoteRoot, "Project memory by-remote root");
  await assertNotSymlink(memoryRoot, "Project memory root");
  await assertChildRealpath(byRemoteRoot, memoryRoot, "Project memory root");
  return true;
}

export async function readProjectMetadata(
  memoryRoot: string,
  storageRoot = defaultStorageRoot(),
): Promise<ProjectMetadata | undefined> {
  if (!(await validateExistingMemoryRoot(storageRoot, memoryRoot)))
    return undefined;
  const metadataPath = join(memoryRoot, "project.json");
  if (!(await pathExists(metadataPath))) return undefined;
  return parseProjectMetadata(
    await readUtf8FileBounded(metadataPath, MAX_METADATA_BYTES),
  );
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

async function assertStoragePathSafe(
  storageRoot: string,
  memoryRoot: string,
): Promise<void> {
  const byRemoteRoot = join(storageRoot, "by-remote");
  await ensureSafeDir(storageRoot, "Project memory storage root");
  await ensureSafeDir(byRemoteRoot, "Project memory by-remote root");
  await assertNotSymlink(memoryRoot, "Project memory root");
  await ensurePrivateDir(memoryRoot);
  await assertNotSymlink(memoryRoot, "Project memory root");
  await assertChildRealpath(byRemoteRoot, memoryRoot, "Project memory root");
}

export async function initializeMemoryStorage(
  identity: ProjectIdentity,
  options: StorageOptions = {},
): Promise<ProjectMemoryContext> {
  const storageRoot = options.root ?? defaultStorageRoot();
  const memoryRoot = memoryRootForProject(identity.projectId, storageRoot);
  await assertStoragePathSafe(storageRoot, memoryRoot);
  await ensureLocksRoot(memoryRoot);

  return withMemoryLock(memoryRoot, "project-json.lock", async () => {
    const existing = await readProjectMetadata(memoryRoot, storageRoot);
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

export async function resolveExistingMemoryContext(
  cwd: string,
  options: StorageOptions = {},
): Promise<ProjectMemoryContext | undefined> {
  const identity = await resolveProjectIdentity(cwd);
  if (!identity) return undefined;
  const storageRoot = options.root ?? defaultStorageRoot();
  const memoryRoot = memoryRootForProject(identity.projectId, storageRoot);
  const metadata = await readProjectMetadata(memoryRoot, storageRoot);
  if (!metadata) return undefined;
  return { identity, memoryRoot, metadata };
}

async function ensureLocksRoot(memoryRoot: string): Promise<string> {
  await assertNotSymlink(memoryRoot, "Project memory root");
  const locksRoot = join(memoryRoot, "locks");
  await assertNotSymlink(locksRoot, "Project memory locks root");
  await ensurePrivateDir(locksRoot);
  await assertNotSymlink(locksRoot, "Project memory locks root");
  await assertChildRealpath(memoryRoot, locksRoot, "Project memory locks root");
  return locksRoot;
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs < LOCK_STALE_MS) return false;
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return true;
    throw error;
  }
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

  const locksRoot = await ensureLocksRoot(memoryRoot);
  const lockPath = join(locksRoot, lockName);
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
      break;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      const removed = await removeStaleLock(lockPath);
      if (!removed && Date.now() >= deadline) throw error;
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

  await assertNotSymlink(memoryRoot, "Project memory root");
  const root = await realpath(memoryRoot);
  const candidate = resolve(root, relativePath);
  let existingParent = candidate;
  while (!(await pathExists(existingParent))) {
    const parent = dirname(existingParent);
    if (parent === existingParent) {
      throw new Error("Memory path escapes project memory root");
    }
    existingParent = parent;
  }
  const realParent = await realpath(existingParent);

  if (realParent !== root && !realParent.startsWith(`${root}/`)) {
    throw new Error("Memory path escapes project memory root");
  }

  return candidate;
}
