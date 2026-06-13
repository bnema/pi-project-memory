export interface SessionEvidenceItem {
  type: "user" | "assistant" | "tool" | "bash";
  content: string;
  source?: string;
}

export const MAX_EVIDENCE_ITEMS = 30;
const MAX_EVIDENCE_CONTENT_BYTES = 4_000;
const MIN_CONTENT_LENGTH = 3;

const LOW_VALUE_PATTERNS: RegExp[] = [
  /^(ok|done|continue|proceed|go ahead|sounds good|looks good|makes sense|let me|now let|moving on|for now|here's|that's|this is|i'll|i can|i have|please|thanks|thank you|great|perfect|excellent|got it|understood|right|agreed|sure|yes|no)\b/i,
  /^[\s.,!?;:'"\-=~]{0,20}$/,
];

// ── Shared utility functions (no dependency on events.ts) ────────

export function truncateUtf8(
  input: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const buffer = Buffer.from(input, "utf8");
  if (buffer.byteLength <= maxBytes) return { text: input, truncated: false };
  let text = buffer.subarray(0, maxBytes).toString("utf8").trimEnd();
  while (Buffer.byteLength(text, "utf8") > maxBytes) {
    text = text.slice(0, -1);
  }
  return { text, truncated: true };
}

export function redactSecrets(input: string): string {
  return input
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret)["']?\s*[=:]\s*)"[^"]*"/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret)["']?\s*[=:]\s*)'[^']*'/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(["']?(?:api[_-]?key|apikey|token|password|passwd|secret)["']?\s*[=:]\s*)[^\s,'"`;}]+/gi,
      "$1[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
}

// ── Internal helpers ──────────────────────────────────────────────

export function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((part) =>
      part &&
      typeof part === "object" &&
      "text" in part &&
      typeof (part as { text: unknown }).text === "string"
        ? (part as { text: string }).text
        : "",
    )
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

// ── Evidence filtering ────────────────────────────────────────────

export function isUsefulEvidence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length < MIN_CONTENT_LENGTH) return false;
  for (const pattern of LOW_VALUE_PATTERNS) {
    if (pattern.test(trimmed)) return false;
  }
  return true;
}

function sanitizeEvidence(text: string): string {
  return truncateUtf8(redactSecrets(text), MAX_EVIDENCE_CONTENT_BYTES).text;
}

export function extractMessageObject(
  entry: unknown,
): Record<string, unknown> | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const wrapped = (entry as { message?: unknown }).message;
  if (wrapped && typeof wrapped === "object")
    return wrapped as Record<string, unknown>;
  const raw = entry as Record<string, unknown>;
  if (
    "role" in raw ||
    "toolName" in raw ||
    "command" in raw ||
    "details" in raw
  ) {
    return raw;
  }
  return undefined;
}

export function extractSessionEvidence(
  entries: unknown[],
  maxItems = MAX_EVIDENCE_ITEMS,
): SessionEvidenceItem[] {
  const evidence: SessionEvidenceItem[] = [];

  for (const entry of entries) {
    if (evidence.length >= maxItems) break;

    const message = extractMessageObject(entry);
    if (!message) continue;

    const msg = message as {
      role?: unknown;
      content?: unknown;
      toolName?: unknown;
      command?: unknown;
      details?: unknown;
    };
    const role = msg.role;

    // Skip system/prompt messages (developer/instruction noise)
    if (role === "system") continue;

    if (role === "user") {
      const text = textFromContent(msg.content);
      if (text && isUsefulEvidence(text)) {
        evidence.push({
          type: "user",
          content: sanitizeEvidence(text.trim()),
        });
      }
    } else if (role === "assistant") {
      const text = textFromContent(msg.content);
      if (text && isUsefulEvidence(text)) {
        evidence.push({
          type: "assistant",
          content: sanitizeEvidence(text.trim()),
        });
      }
    } else if (role === "bashExecution") {
      const cmd = msg.command;
      if (typeof cmd === "string" && cmd.trim()) {
        const sanitized = sanitizeEvidence(cmd.trim());
        evidence.push({ type: "bash", content: sanitized, source: sanitized });
      }
    } else if (role === "toolResult" || typeof msg.toolName === "string") {
      const toolName = msg.toolName;
      const details = msg.details;
      let cmd: unknown;
      if (
        toolName === "bash" &&
        details &&
        typeof details === "object" &&
        "command" in details
      ) {
        cmd = (details as { command?: unknown }).command;
      }
      if (typeof cmd === "string" && cmd.trim()) {
        const sanitized = sanitizeEvidence(cmd.trim());
        evidence.push({ type: "bash", content: sanitized, source: sanitized });
      } else {
        const text = textFromContent(msg.content);
        if (text && isUsefulEvidence(text)) {
          evidence.push({
            type: "tool",
            content: sanitizeEvidence(text.trim()),
            source: typeof toolName === "string" ? toolName : undefined,
          });
        }
      }
    }
  }

  return evidence;
}
