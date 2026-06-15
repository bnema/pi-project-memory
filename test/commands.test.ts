import { execFile } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { complete } from "@earendil-works/pi-ai";
import { handleProjectMemoryCommand } from "../src/commands";
import { resolveMemoryContext } from "../src/storage";

vi.mock("@earendil-works/pi-ai", () => ({ complete: vi.fn() }));
const mockedComplete = vi.mocked(complete);
const execFileAsync = promisify(execFile);
const rootsToCleanup: string[] = [];

async function git(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function createRepo(taskId: string) {
  const repo = join("/tmp", `pm-command-repo-${process.pid}-${taskId}`);
  const memoryRoot = join("/tmp", `pm-command-store-${process.pid}-${taskId}`);
  rootsToCleanup.push(repo, memoryRoot);
  await mkdir(repo, { recursive: true });
  await git(["init"], repo);
  await git(["remote", "add", "origin", "git@github.com:org/repo.git"], repo);
  process.env.PI_PROJECT_MEMORY_ROOT = memoryRoot;
  const context = await resolveMemoryContext(repo);
  if (!context) throw new Error("expected memory context");
  const notices: Array<{ message: string; level?: string }> = [];
  return {
    repo,
    context,
    notices,
    ctx: {
      cwd: repo,
      hasUI: false,
      ui: {
        notify: (message: string, level?: "info" | "warning" | "error") =>
          notices.push({ message, level }),
        confirm: async () => false,
      },
      sessionManager: {
        getBranch: () => [
          { message: { role: "user", content: "Remember architecture" } },
          {
            message: {
              role: "assistant",
              content: "Project uses npm test for verification.",
            },
          },
          { message: { role: "bashExecution", command: "npm test" } },
        ],
      },
      model: { provider: "fake", id: "model" } as never,
      modelRegistry: {
        find: () => undefined,
        async getApiKeyAndHeaders() {
          return { ok: true, apiKey: "key" };
        },
      },
    },
  };
}

afterEach(async () => {
  mockedComplete.mockReset();
  delete process.env.PI_PROJECT_MEMORY_ROOT;
  await Promise.all(
    rootsToCleanup
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("project-memory command cutover", () => {
  it("shows usage without verify", async ({ task }) => {
    const { ctx, notices } = await createRepo(task.id);
    await handleProjectMemoryCommand("wat", ctx);
    expect(notices.at(-1)).toEqual({
      message:
        "Usage: /project-memory status | open | reset | checkpoint | update | enable-auto | disable-auto",
      level: "warning",
    });
  });

  it("captures checkpoint only", async ({ task }) => {
    const { ctx, context, notices } = await createRepo(task.id);
    await handleProjectMemoryCommand("checkpoint", ctx);
    expect(notices.at(-1)?.message).toContain(
      "Project memory evidence captured pending event",
    );
    expect(
      await readFile(join(context.memoryRoot, "evidence.jsonl"), "utf8"),
    ).toContain("npm test");
  });

  it("update consolidates evidence through stage1 into rendered memory files", async ({
    task,
  }) => {
    const { ctx, context, notices } = await createRepo(task.id);
    mockedComplete.mockResolvedValueOnce({
      role: "assistant",
      timestamp: Date.now(),
      content: [
        {
          type: "text",
          text: JSON.stringify({
            raw_memory: "Use npm test for verification.",
            rollout_summary: "Testing command",
            rollout_slug: "testing-command",
          }),
        },
      ],
    } as Awaited<ReturnType<typeof complete>>);

    await handleProjectMemoryCommand("update", ctx);

    expect(notices.at(-1)?.message).toContain("Project memory update complete");

    // Stage-1 artifact written (core consolidated artifact)
    expect(
      await readFile(join(context.memoryRoot, "stage1-outputs.jsonl"), "utf8"),
    ).toContain("testing-command");

    // Rendered memory files regenerated from stage1 artifacts
    const memoryMd = await readFile(
      join(context.memoryRoot, "MEMORY.md"),
      "utf8",
    );
    expect(memoryMd).toContain("Testing command");
    expect(memoryMd).toContain("Use npm test for verification");
    const summaryMd = await readFile(
      join(context.memoryRoot, "memory_summary.md"),
      "utf8",
    );
    expect(summaryMd).toContain("Testing command");

    // Old facts.jsonl is never written
    await expect(
      readFile(join(context.memoryRoot, "facts.jsonl"), "utf8"),
    ).rejects.toThrow(/ENOENT/);
  });

  it("verify is removed", async ({ task }) => {
    const { ctx, notices } = await createRepo(task.id);
    await handleProjectMemoryCommand("verify", ctx);
    expect(notices.at(-1)?.message).toContain("Usage: /project-memory");
  });
});
