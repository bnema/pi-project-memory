import { describe, expect, it } from "vitest";
import { buildProjectMemoryBlock } from "../src/prompts";

describe("project memory skeleton", () => {
  it("omits empty prompt blocks", () => {
    expect(buildProjectMemoryBlock("  ")).toBe("");
  });

  it("marks injected memory as untrusted", () => {
    expect(buildProjectMemoryBlock("Known command: npm test")).toContain(
      "untrusted local project-memory data",
    );
  });
});
