export type MemoryScope = "git-remote" | "path";

export interface ProjectIdentity {
  projectId: string;
  canonicalSource: string;
  scope: MemoryScope;
  gitRoot: string;
  remoteUrl?: string;
  warning?: string;
}

export interface ProjectMetadata {
  projectId: string;
  canonicalRemote: string;
  scope: MemoryScope;
  aliases: string[];
  seenRoots: string[];
  createdAt: string;
  lastSeenAt: string;
}

export interface ProjectMemoryContext {
  identity: ProjectIdentity;
  memoryRoot: string;
  metadata: ProjectMetadata;
}

export interface ToolTextResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
}
