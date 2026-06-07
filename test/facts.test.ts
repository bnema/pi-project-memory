import { describe, expect, it } from "vitest";
import {
  applyCandidates,
  factId,
  parseFact,
  renderMemoryMarkdown,
  renderMemorySummary,
  type ProjectFact,
} from "../src/facts";

function fact(overrides: Partial<ProjectFact> = {}): ProjectFact {
  return {
    schemaVersion: 1,
    id: "fact_one",
    kind: "observation",
    topic: "architecture",
    scope: "whole_project",
    text: "The app uses adapters.",
    evidence: [{ type: "user", note: "explicit" }],
    confidence: "verified",
    status: "active",
    stalenessTriggers: [],
    sourceEventIds: ["event_one"],
    createdAt: "2026-06-07T00:00:00.000Z",
    updatedAt: "2026-06-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("facts", () => {
  it("uses broad kind/topic facets", () => {
    expect(
      parseFact(fact({ kind: "relationship", topic: "data" })),
    ).toMatchObject({
      kind: "relationship",
      topic: "data",
    });
    expect(parseFact({ ...fact(), kind: "user_preference" })).toBeUndefined();
  });

  it("creates stable non-colliding ids", () => {
    const prefix = "same prefix ".repeat(20);
    expect(factId("fact", `${prefix}a`)).not.toBe(factId("fact", `${prefix}b`));
  });

  it("rejects invalid evidence and timestamp shapes", () => {
    expect(
      parseFact({ ...fact(), evidence: [{ type: "user", note: 123 }] }),
    ).toBeUndefined();
    expect(
      parseFact({ ...fact(), evidence: [{ type: "other", note: "x" }] }),
    ).toBeUndefined();
    expect(
      parseFact({ ...fact(), lastVerifiedAt: { bad: true } }),
    ).toBeUndefined();
  });

  it("does not apply confirmation-required removals unless approved", () => {
    const existing = [fact()];
    expect(
      applyCandidates(
        existing,
        [
          {
            action: "remove",
            factId: "fact_one",
            confirmationRequired: true,
            reason: "test",
          },
        ],
        new Set(),
      ),
    ).toHaveLength(1);
    expect(
      applyCandidates(
        existing,
        [
          {
            action: "remove",
            factId: "fact_one",
            confirmationRequired: true,
            reason: "test",
          },
        ],
        new Set([0]),
      ),
    ).toHaveLength(0);
  });

  it("does not approve duplicate-id candidates by fact id", () => {
    const existing = [fact()];
    const next = applyCandidates(
      existing,
      [
        {
          action: "update",
          fact: fact({ text: "Approved update" }),
          confirmationRequired: true,
          reason: "approved",
        },
        {
          action: "remove",
          factId: "fact_one",
          confirmationRequired: true,
          reason: "rejected",
        },
      ],
      new Set([0]),
    );
    expect(next).toHaveLength(1);
    expect(next[0]?.text).toBe("Approved update");
  });

  it("redacts generated artifact content", () => {
    const dirty = fact({
      text: "token=secret",
      evidence: [{ type: "user", note: "password=secret" }],
    });
    const markdown = renderMemoryMarkdown([dirty]);
    const summary = renderMemorySummary([dirty]);
    expect(markdown).not.toContain("secret");
    expect(summary).not.toContain("secret");
  });
});
