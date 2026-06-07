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

function decodePathSegmentWhenUnambiguous(segment: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.includes("/") || decoded.includes("\\") ? segment : decoded;
  } catch {
    return segment;
  }
}

function decodePathSegments(pathname: string): string {
  return pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathSegmentWhenUnambiguous)
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

  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("\\\\") ||
    trimmed.startsWith("//") ||
    /^[A-Za-z]:/.test(trimmed)
  ) {
    throw new Error("Local path remotes are not canonical Git remotes");
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  const scpLike = trimmed.match(/^([^@\s:]+@)?([^:\s/]+):(.+)$/);
  if (scpLike && !hasScheme) {
    const host = scpLike[2]!.toLowerCase();
    const path = stripGitSuffix(decodePathSegments(scpLike[3]!));
    return `${host}/${path.replace(/^\/+/, "")}`;
  }

  if (
    !hasScheme &&
    trimmed.includes("/") &&
    !trimmed.split("/", 1)[0]!.includes(".")
  ) {
    throw new Error("Relative path remotes are not canonical Git remotes");
  }

  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;
  const parsed = new URL(withScheme);
  if (parsed.protocol === "file:") {
    throw new Error("Local file remotes are not canonical Git remotes");
  }
  if (!parsed.hostname || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("Remote URL must include a host and repository path");
  }
  return normalizeUrl(parsed);
}

export async function resolveProjectIdentity(
  cwd: string,
  remote = "origin",
): Promise<ProjectIdentity | undefined> {
  const root = await gitRoot(cwd);
  if (!root) return undefined;

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(root);
  } catch {
    return undefined;
  }

  const remoteUrl = await gitRemoteUrl(canonicalRoot, remote);
  if (remoteUrl) {
    try {
      const canonicalSource = normalizeRemoteUrl(remoteUrl);
      return {
        projectId: sha256(`git:${canonicalSource}`),
        canonicalSource,
        scope: "git-remote",
        gitRoot: canonicalRoot,
        remoteUrl,
      };
    } catch {
      return {
        projectId: sha256(`path:${canonicalRoot}`),
        canonicalSource: canonicalRoot,
        scope: "path",
        gitRoot: canonicalRoot,
        remoteUrl,
        warning:
          "Origin remote is local or unsupported; memory is path-scoped.",
      };
    }
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
