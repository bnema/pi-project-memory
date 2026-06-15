import { createHash } from "node:crypto";
import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import { open } from "node:fs/promises";
import {
  redactSecrets,
  truncateUtf8,
  type SessionEvidenceItem,
} from "./evidence";
import {
  buildStage1ExtractionPrompt,
  STAGE1_SYSTEM_INSTRUCTION,
} from "./prompts";
import { assertInsideMemoryRoot } from "./storage";

// ── Types ──────────────────────────────────────────────────────────

/**
 * Structured output expected from the stage-1 extraction model.
 *
 * - raw_memory:      Verbatim project-memory content extracted from evidence.
 * - rollout_summary: One-line title/summary of what this memory captures.
 * - rollout_slug:    Unique kebab-case slug for this rollout.
 */
export interface Stage1Output {
  raw_memory: string;
  rollout_summary: string;
  rollout_slug: string;
}

/**
 * On-disk record for a stage-1 extraction, appended to stage1-outputs.jsonl.
 * Used as input for later phase-3 consolidation.
 *
 * Storage path: <memoryRoot>/stage1-outputs.jsonl
 *
 * Format: one JSON line per extraction.  Each line is a Stage1Record.
 * Artifact rendering reads these records directly when regenerating memory files.
 */
export interface Stage1Record {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  result: Stage1Output;
  model: string;
}

/**
 * Auth/resolution context for stage-1 extraction.
 * Mirrors the ConsolidationContext pattern from consolidation.ts.
 */
export interface Stage1Context<TApi extends Api = Api> {
  model?: Model<TApi>;
  modelRegistry?: {
    find(provider: string, modelId: string): Model<TApi> | undefined;
    getApiKeyAndHeaders(
      model: Model<TApi>,
    ): Promise<
      | { ok: true; apiKey?: string; headers?: Record<string, string> }
      | { ok: false; error: string }
    >;
  };
  signal?: AbortSignal;
}

/**
 * Result of a stage-1 extraction attempt.
 *
 * - "ok":        Successful extraction with non-empty output persisted.
 * - "no-output":            Model returned empty raw_memory/rollout_summary → valid no-op.
 * - "rejected-low-quality": Model returned output that fails the durable-knowledge quality gate.
 * - "error":                 Model failure, auth failure, or invalid response.
 */
export type Stage1Status =
  | "ok"
  | "no-output"
  | "rejected-low-quality"
  | "error";

export interface Stage1Result {
  status: Stage1Status;
  output?: Stage1Output;
  error?: string;
  modelUsed?: string;
  attemptedCalls?: number;
  outputEstimate?: number;
}

// ── Constants ──────────────────────────────────────────────────────

/** JSONL file under memoryRoot where stage-1 outputs are persisted. */
const STAGE1_OUTPUTS_FILE = "stage1-outputs.jsonl";

/** Max chars for evidence input sent to the model. */
const MAX_EVIDENCE_INPUT_CHARS = 32_000;

/** Max tokens for model output. */
const MODEL_OUTPUT_MAX_TOKENS = 2_000;

// ── Helpers ────────────────────────────────────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildStage1Input(evidence: SessionEvidenceItem[]): string {
  const input = redactSecrets(JSON.stringify({ evidence }, null, 2));
  return truncateUtf8(input, MAX_EVIDENCE_INPUT_CHARS).text;
}

/**
 * Parse a JSON object from model text output.
 * Accepts either raw JSON or JSON fenced in ```json … ```.
 */
function parseStage1Output(text: string): Stage1Output | undefined {
  const jsonText = text.match(/```json\s*([\s\S]*?)```/)?.[1] ?? text;
  try {
    const parsed = JSON.parse(jsonText) as Record<string, unknown>;
    if (
      typeof parsed.raw_memory === "string" &&
      typeof parsed.rollout_summary === "string" &&
      typeof parsed.rollout_slug === "string"
    ) {
      return {
        raw_memory: parsed.raw_memory,
        rollout_summary: parsed.rollout_summary,
        rollout_slug: parsed.rollout_slug,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Quality-check a Stage1Output for durable project knowledge.
 *
 * Returns true if the output encodes durable project knowledge
 * (architecture, conventions, commands, project structure, known issues)
 * that would be useful to a future agent working in the same project.
 *
 * Returns false if the output is transient — branch-specific,
 * task-oriented, process-heavy, or session-scoped content that should
 * not be persisted as project memory.
 *
 * Transient patterns detected:
 * - "Working on X" / "The agent did Y" (process narrative)
 * - "This session" / "current branch" (session-scoped)
 * - Branch name references
 *
 * Durable patterns that pass:
 * - Architecture facts ("Routes follow...", "Project uses...")
 * - Command conventions ("Run `npm test` before...")
 * - Project structure notes
 * - Known issues / landmines
 */
export function isDurableKnowledge(output: Stage1Output): boolean {
  const combined = `${output.rollout_summary} ${output.raw_memory}`;

  // Patterns that indicate transient session/process/task content
  const transientPatterns = [
    /\bworking on\b/i,
    /\bthis session\b/i,
    /\bcurrent (branch|task|sprint)\b/i,
    /\bon the [\w/-]+ branch\b/i,
    /\bthe agent\b/i,
  ];

  for (const pattern of transientPatterns) {
    if (pattern.test(combined)) return false;
  }

  return true;
}

/** Select which models to attempt, preferring the active model if set. */
export function pickStage1Models<TApi extends Api>(
  ctx: Stage1Context<TApi>,
): Model<TApi>[] {
  const models: Model<TApi>[] = [];
  if (ctx.model) models.push(ctx.model);
  const fallback = ctx.modelRegistry?.find("google", "gemini-2.5-flash");
  if (
    fallback &&
    !models.some(
      (m) => m.provider === fallback.provider && m.id === fallback.id,
    )
  ) {
    models.push(fallback);
  }
  return models;
}

// ── Persistence ────────────────────────────────────────────────────

/**
 * Append a stage-1 extraction record to the JSONL storage file.
 *
 * Storage format: <memoryRoot>/stage1-outputs.jsonl
 *
 * Each line is a Stage1Record JSON object with schemaVersion, id (rollout_slug),
 * createdAt ISO timestamp, the full result, and the model identifier.
 *
 * Artifact rendering reads this file directly when regenerating memory files.
 */
export async function persistStage1Output(
  memoryRoot: string,
  output: Stage1Output,
  modelUsed: string,
): Promise<void> {
  const createdAt = new Date().toISOString();
  const record: Stage1Record = {
    schemaVersion: 1,
    id: `stage1_${createHash("sha256").update(`${createdAt}:${modelUsed}:${output.rollout_slug}:${output.raw_memory}`).digest("hex").slice(0, 12)}`,
    createdAt,
    result: output,
    model: modelUsed,
  };
  const filePath = await assertInsideMemoryRoot(
    memoryRoot,
    STAGE1_OUTPUTS_FILE,
  );
  const handle = await open(filePath, "a", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

// ── Main entry point ───────────────────────────────────────────────

/**
 * Run stage-1 extraction on filtered session evidence.
 *
 * Given a set of filtered SessionEvidenceItem records, this function:
 * 1. Builds a prompt using the stage-1 extraction contract.
 * 2. Calls the preferred model (active model first, fallback to registry default).
 * 3. Validates the model JSON output against the Stage1Output contract.
 * 4. Treats empty raw_memory or rollout_summary as valid no-output success.
 * 5. Returns successful non-empty outputs for the caller to persist atomically.
 *
 * Auth:
 * - API-key auth:    modelRegistry returns { apiKey: "..." }.
 * - Subscription/OAuth: modelRegistry returns { headers: { authorization: "Bearer ..." } } with no apiKey.
 */
export async function extractStage1Memory(
  evidence: SessionEvidenceItem[],
  ctx: Stage1Context = {},
): Promise<Stage1Result> {
  if (!ctx.modelRegistry) {
    return { status: "error", error: "no model registry" };
  }

  const models = pickStage1Models(ctx);
  if (models.length === 0) {
    return { status: "error", error: "no model available" };
  }

  const input = buildStage1Input(evidence);
  const userPrompt = buildStage1ExtractionPrompt(input);

  let sawCompletionFailure = false;
  let lastAttemptedModelUsed: string | undefined;
  let attemptedCalls = 0;
  let totalOutputEstimate = 0;

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      continue;
    }

    let response;
    try {
      response = await complete(
        model,
        {
          systemPrompt: STAGE1_SYSTEM_INSTRUCTION,
          messages: [
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: userPrompt }],
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          maxTokens: MODEL_OUTPUT_MAX_TOKENS,
          signal: ctx.signal,
        },
      );
    } catch {
      sawCompletionFailure = true;
      lastAttemptedModelUsed = `${model.provider}/${model.id}`;
      attemptedCalls += 1;
      continue;
    }

    const text = response.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n");

    attemptedCalls += 1;
    const outputEstimate = estimateTokens(text);
    totalOutputEstimate += outputEstimate;
    const output = parseStage1Output(text);
    if (!output) {
      return {
        status: "error",
        error: "model produced invalid output",
        modelUsed: `${model.provider}/${model.id}`,
        attemptedCalls,
        outputEstimate: totalOutputEstimate,
      };
    }

    // No-output success: empty raw_memory or rollout_summary.
    // Empty rollout_slug is invalid schema output, not a benign no-output.
    if (!output.rollout_slug.trim()) {
      return {
        status: "error",
        error: "model produced invalid output",
        modelUsed: `${model.provider}/${model.id}`,
        attemptedCalls,
        outputEstimate: totalOutputEstimate,
      };
    }

    if (!output.raw_memory.trim() || !output.rollout_summary.trim()) {
      return {
        status: "no-output",
        modelUsed: `${model.provider}/${model.id}`,
        output,
        attemptedCalls,
        outputEstimate: totalOutputEstimate,
      };
    }

    // Quality gate: reject transient/branch/process-heavy output
    if (!isDurableKnowledge(output)) {
      return {
        status: "rejected-low-quality",
        modelUsed: `${model.provider}/${model.id}`,
        output,
        attemptedCalls,
        outputEstimate: totalOutputEstimate,
      };
    }

    return {
      status: "ok",
      output,
      modelUsed: `${model.provider}/${model.id}`,
      attemptedCalls,
      outputEstimate: totalOutputEstimate,
    };
  }

  return {
    status: "error",
    error: sawCompletionFailure
      ? "model completion failed"
      : "model auth unavailable",
    attemptedCalls,
    outputEstimate: totalOutputEstimate,
    modelUsed: lastAttemptedModelUsed,
  };
}
