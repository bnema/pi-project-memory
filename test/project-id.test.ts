import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl, sha256 } from "../src/project-id";

describe("normalizeRemoteUrl", () => {
  it.each([
    ["git@github.com:org/repo.git", "github.com/org/repo"],
    ["https://github.com/org/repo", "github.com/org/repo"],
    ["ssh://git@github.com/org/repo.git", "github.com/org/repo"],
    [
      "ssh://git@git.example.com:2222/group/subgroup/repo.git",
      "git.example.com:2222/group/subgroup/repo",
    ],
    ["https://GitHub.com/Org/Repo.git", "github.com/Org/Repo"],
    ["github.com/user/repo", "github.com/user/repo"],
    [
      "https://gitlab.com/group/subgroup/repo.git",
      "gitlab.com/group/subgroup/repo",
    ],
    [
      "https://example.com/group%20name/repo.git",
      "example.com/group name/repo",
    ],
    ["https://example.com/group%2Frepo.git", "example.com/group%2Frepo"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRemoteUrl(input)).toBe(expected);
  });

  it("keeps encoded slashes distinct from path separators", () => {
    expect(normalizeRemoteUrl("https://example.com/group%2Frepo.git")).not.toBe(
      normalizeRemoteUrl("https://example.com/group/repo.git"),
    );
  });

  it("rejects local path remotes instead of colliding with network hosts", () => {
    expect(() => normalizeRemoteUrl("/tmp/repo.git")).toThrow(/Local path/);
    expect(() => normalizeRemoteUrl("../repo.git")).toThrow(/Local path/);
    expect(() => normalizeRemoteUrl("deps/repo.git")).toThrow(/Relative path/);
    expect(() => normalizeRemoteUrl("C:/repo.git")).toThrow(/Local path/);
    expect(() => normalizeRemoteUrl("C:\\repo.git")).toThrow(/Local path/);
    expect(() => normalizeRemoteUrl("C:repo.git")).toThrow(/Local path/);
    expect(() => normalizeRemoteUrl("\\\\server\\share\\repo.git")).toThrow(
      /Local path/,
    );
    expect(() => normalizeRemoteUrl("file://localhost/tmp/repo.git")).toThrow(
      /Local file/,
    );
  });

  it("keeps forks distinct", () => {
    expect(normalizeRemoteUrl("git@github.com:user/repo.git")).not.toBe(
      normalizeRemoteUrl("git@github.com:org/repo.git"),
    );
  });

  it("hashes project ids deterministically", () => {
    expect(sha256("git:github.com/org/repo")).toHaveLength(64);
    expect(sha256("git:github.com/org/repo")).toBe(
      sha256("git:github.com/org/repo"),
    );
  });
});
