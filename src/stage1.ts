import { complete, type Api, type Model } from "@earendil-works/pi-ai";
import { open } from "node:fs/promises";
import {
  redactSecrets,
  truncateUtf8,
  type SessionEvidenceItem,
} from "./evidence";
import { STAGE1_EXTRACTION_PROMPT, STAGE1_SYSTEM_INSTRUCTION } from "./prompts";
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
 * Phase 3 will read these records and consolidate them into ProjectFact[].
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
 * - "no-output": Model returned empty raw_memory/rollout_summary → valid no-op.
 * - "error":     Model failure, auth failure, or invalid response.
 */
export type Stage1Status = "ok" | "no-output" | "error";

export interface Stage1Result {
  status: Stage1Status;
  output?: Stage1Output;
  error?: string;
  modelUsed?: string;
}

// ── Constants ──────────────────────────────────────────────────────

/** JSONL file under memoryRoot where stage-1 outputs are persisted. */
const STAGE1_OUTPUTS_FILE = "stage1-outputs.jsonl";

/** Max chars for evidence input sent to the model. */
const MAX_EVIDENCE_INPUT_CHARS = 32_000;

/** Max tokens for model output. */
const MODEL_OUTPUT_MAX_TOKENS = 2_000;

// ── Helpers ────────────────────────────────────────────────────────

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

/** Select which models to attempt, preferring the active model if set. */
function pickStage1Models<TApi extends Api>(
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
 * Phase 3 will read this file and consolidate records into ProjectFact[],
 * then remove processed lines.
 */
async function persistStage1Output<TApi extends Api>(
  memoryRoot: string,
  output: Stage1Output,
  model: Model<TApi>,
): Promise<void> {
  const record: Stage1Record = {
    schemaVersion: 1,
    id: output.rollout_slug,
    createdAt: new Date().toISOString(),
    result: output,
    model: `${model.provider}/${model.id}`,
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
 * 5. Persists successful non-empty outputs to stage1-outputs.jsonl.
 *
 * Auth:
 * - API-key auth:    modelRegistry returns { apiKey: "..." }.
 * - Subscription/OAuth: modelRegistry returns { headers: { authorization: "Bearer ..." } } with no apiKey.
 */
export async function extractStage1Memory(
  evidence: SessionEvidenceItem[],
  memoryRoot: string,
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
  const userPrompt = STAGE1_EXTRACTION_PROMPT(input);

  let sawAuthFailure = false;

  for (const model of models) {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      sawAuthFailure = true;
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
      return { status: "error", error: "model completion failed" };
    }

    const text = response.content
      .filter(
        (part): part is { type: "text"; text: string } => part.type === "text",
      )
      .map((part) => part.text)
      .join("\n");

    const output = parseStage1Output(text);
    if (!output) {
      return {
        status: "error",
        error: "model produced invalid output",
        modelUsed: `${model.provider}/${model.id}`,
      };
    }

    // No-output success: empty raw_memory or rollout_summary
    // This is a valid result, not an error — the evidence had nothing durable.
    if (!output.raw_memory.trim() || !output.rollout_summary.trim()) {
      return {
        status: "no-output",
        modelUsed: `${model.provider}/${model.id}`,
        output,
      };
    }

    // Persist successful extraction
    await persistStage1Output(memoryRoot, output, model);

    return {
      status: "ok",
      output,
      modelUsed: `${model.provider}/${model.id}`,
    };
  }

  return {
    status: "error",
    error: sawAuthFailure ? "model auth unavailable" : "no model",
  };
}
