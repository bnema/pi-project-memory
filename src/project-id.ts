import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import type { ProjectIdentity } from "./types";

const execFileAsync = promisify(execFile);

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function gitRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function gitRemoteUrl(
  gitRootPath: string,
  remote = "origin",
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", remote],
      { cwd: gitRootPath },
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function stripGitSuffix(pathname: string): string {
  return pathname.endsWith(".git") ? pathname.slice(0, -4) : pathname;
}

function decodePathSegments(pathname: string): string {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join("/");
}

function normalizeUrl(input: URL): string {
  const host = input.hostname.toLowerCase();
  const port = input.port ? `:${input.port}` : "";
  const path = stripGitSuffix(decodePathSegments(input.pathname));
  return `${host}${port}/${path}`;
}

/**
 * Normalize common Git remote URL forms to a conservative canonical source.
 * Host is lower-cased; path case is preserved to avoid merging case-sensitive repos.
 */
export function normalizeRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) throw new Error("Remote URL is empty");

  const scpLike = trimmed.match(/^([^@\s:]+@)?([^:\s/]+):(.+)$/);
  if (scpLike && !trimmed.includes("://")) {
    const host = scpLike[2]!.toLowerCase();
    const path = stripGitSuffix(decodePathSegments(scpLike[3]!));
    return `${host}/${path.replace(/^\/+/, "")}`;
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  return normalizeUrl(parsed);
}

export async function resolveProjectIdentity(
  cwd: string,
  remote = "origin",
): Promise<ProjectIdentity | undefined> {
  const root = await gitRoot(cwd);
  if (!root) return undefined;

  const canonicalRoot = await realpath(root);
  const remoteUrl = await gitRemoteUrl(canonicalRoot, remote);
  if (remoteUrl) {
    const canonicalSource = normalizeRemoteUrl(remoteUrl);
    return {
      projectId: sha256(`git:${canonicalSource}`),
      canonicalSource,
      scope: "git-remote",
      gitRoot: canonicalRoot,
      remoteUrl,
    };
  }

  return {
    projectId: sha256(`path:${canonicalRoot}`),
    canonicalSource: canonicalRoot,
    scope: "path",
    gitRoot: canonicalRoot,
    warning:
      "No origin remote found; memory is path-scoped until a remote is configured.",
  };
}
