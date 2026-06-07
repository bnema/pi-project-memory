import type { ProjectMemoryContext } from "./types";

export interface StorageOptions {
  root?: string;
}

export async function resolveMemoryContext(
  _cwd: string,
  _options: StorageOptions = {},
): Promise<ProjectMemoryContext | undefined> {
  return undefined;
}
