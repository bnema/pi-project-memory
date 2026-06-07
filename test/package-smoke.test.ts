import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import projectMemoryExtension from "../extensions/index";

describe("package smoke", () => {
  it("declares Pi package metadata and loadable extension export", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8")) as {
      keywords?: string[];
      pi?: { extensions?: string[] };
      files?: string[];
      exports?: Record<string, string>;
    };

    expect(pkg.keywords).toContain("pi-package");
    expect(pkg.pi?.extensions).toEqual(["./extensions"]);
    expect(pkg.files).toEqual(expect.arrayContaining(["extensions", "src"]));
    expect(pkg.exports?.["."]).toBe("./extensions/index.ts");
    expect(typeof projectMemoryExtension).toBe("function");
  });
});
