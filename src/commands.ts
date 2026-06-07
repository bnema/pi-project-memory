import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function registerProjectMemoryCommand(pi: ExtensionAPI): void {
  pi.registerCommand("project-memory", {
    description: "Inspect and manage project-scoped local memory",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        "pi-project-memory command skeleton loaded; status/read tools arrive in Phase 3.",
        "info",
      );
    },
  });
}
