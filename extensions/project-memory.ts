import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProjectMemoryCommand } from "../src/commands";
import { registerProjectMemoryTools } from "../src/tools";

export default function projectMemoryExtension(pi: ExtensionAPI): void {
  registerProjectMemoryTools(pi);
  registerProjectMemoryCommand(pi);
}
