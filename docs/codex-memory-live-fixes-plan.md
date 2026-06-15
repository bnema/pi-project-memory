# Codex-informed live-fix plan for `pi-project-memory`

## Goal

Stabilize the live `pi-project-memory` plugin after the recent Phase 2 consolidation work by fixing real operational failures seen on personal projects, while borrowing the right ideas from Codex memory without copying Codex's global-memory model.

## Current live problems

Observed on real local stores:

1. `dumber` can hit `Pending events exceed size limit`, which blocks promotion entirely.
2. Some repos capture evidence but never promote it into `stage1-outputs.jsonl`, `MEMORY.md`, or `memory_summary.md`.
3. One repo shows mixed legacy and current store files.
4. `pi-project-memory` itself injected stale old-format summary content because `before_agent_start` trusted an existing `memory_summary.md` too blindly.
5. Saved memory quality is still often too branch/task/process heavy.

## Codex comparison

### What Codex does that is relevant

Codex has a heavier memory pipeline with clearer separation between:

- capture / selection
- Stage 1 extraction
- Phase 2 consolidation
- prompt injection / read path
- usage feedback and retention

Important Codex properties:

- memory is **global/user-scoped**, not per-project
- Phase 2 uses explicit consolidation artifacts such as `raw_memories.md` and `rollout_summaries/*.md`
- `memory_summary.md` has a strict `v1` contract
- consolidation tolerates incremental refreshes and stale-artifact regeneration better than the current Pi flow
- read-path guidance is explicit: skim summary first, then search/read deeper memory only when needed

### What Pi should adopt

Adopt from Codex:

- explicit queue/promotion state
- summary schema/versioning and freshness checks
- stronger separation between capture, extraction, and consolidation outcomes
- better visibility into why memory did or did not promote
- better quality gates for durable memory vs process noise

Reject from Codex:

- one global cross-project memory root
- global cross-project selection/retention behavior
- a full clone of Codex's heavy workspace and git-diff driven Phase 2

## Recommendation

Build a **project-scoped Codex-lite follow-up**, not a global Codex clone.

That means:

- keep `by-remote/` and `by-path/` storage
- fix backlog handling first
- make promotion outcomes visible
- validate summary freshness before injection
- tighten memory quality rules
- only introduce richer consolidation mechanics where they solve a live problem

## Priority order

Do **Phase 1 first** because backlog overflow is a hard blocker. The summary freshness and quality work are valuable, but they matter less if consolidation cannot safely inspect pending evidence.

---

## Phase 1 — Byte-bounded backlog and visible backlog diagnostics

### Goal

Make pending evidence safe to read, prune, and diagnose.

### Key files

- `src/events.ts`
- `src/consolidation.ts`
- `src/tools.ts`
- `test/events.test.ts`
- `test/consolidation.test.ts`
- `test/tools.test.ts`

### Changes

- Add a shared backlog inspector that reports:
  - evidence event count
  - trusted note count
  - byte size per pending file
  - oldest/newest timestamps
  - malformed line count
  - near-cap / over-cap status
- Replace count-only pruning with combined:
  - max event count
  - max byte size below consolidation read limits
- Make oversized pending evidence recoverable instead of fatal:
  - prune oldest evidence first, or
  - read a bounded valid tail and log the drop
- Keep trusted/manual notes safer than raw evidence; do not silently discard them without explicit handling
- Extend `project_memory_status` and `/project-memory status` to expose backlog size and pressure

### Acceptance criteria

- `/project-memory update` no longer hard-fails on oversized evidence backlog
- status shows both pending count and pending bytes
- status distinguishes “initialized but no artifacts” from “artifacts missing because pending backlog is blocked”
- bounded-read and redaction guarantees remain intact

### Verification

```bash
rtk npm run typecheck
rtk vitest run test/events.test.ts test/consolidation.test.ts test/tools.test.ts
rtk npm run verify
```

---

## Phase 2 — Explicit promotion outcomes and queue/job visibility

### Goal

Make it obvious why evidence was captured but not promoted.

### Key files

- `src/auto-update.ts`
- `src/consolidation.ts`
- `src/events.ts` or new `src/backlog.ts`
- `src/tools.ts`
- `test/auto-update.test.ts`
- `test/consolidation.test.ts`
- `test/commands.test.ts`

### Changes

- Extend queue/job state with fields such as:
  - `lastCaptureAt`
  - `lastPromotionAttemptAt`
  - `lastPromotionOutcome`
  - `lastPromotionReason`
  - `pendingEvidenceCount`
  - `pendingEvidenceBytes`
  - `lastSuccessfulStage1At`
- Make consolidation outcomes clearer:
  - `promoted`
  - `no-durable-memory`
  - `model-unavailable`
  - `budget-exhausted`
  - `invalid-output`
  - `oversized-pruned`
  - `no-pending-events`
- Stop auto-update from only attempting the newest high-signal event while older pending evidence becomes invisible
- Preserve pending evidence when budget/model availability blocks promotion, but make that state visible
- Improve notifications so the user sees the actionable reason, not just a vague skip/fail

### Acceptance criteria

- model-unavailable and budget-exhausted states are visible in status
- later successful updates drain older pending evidence rather than only the newest event
- logs are machine-readable enough for status to summarize the latest outcome

### Verification

```bash
rtk vitest run test/auto-update.test.ts test/consolidation.test.ts test/commands.test.ts
rtk npm run verify
```

---

## Phase 3 — Summary schema/versioning, freshness validation, and legacy-store detection

### Goal

Prevent stale or old-format summaries from being injected, and make mixed legacy/current stores visible.

### Key files

- `src/memory-artifacts.ts`
- `src/prompts.ts`
- `extensions/project-memory.ts`
- `src/tools.ts`
- `src/storage.ts` or new `src/legacy.ts`
- `test/memory-artifacts.test.ts`
- `test/extension.test.ts`
- `test/tools.test.ts`
- `test/storage.test.ts` or new `test/legacy.test.ts`

### Changes

- Add a lightweight summary schema marker / freshness metadata to `memory_summary.md`
- Validate summaries before injection:
  - supported version
  - non-empty body
  - not older than current sources
  - generated by current renderer shape
- Change `before_agent_start` to skip stale/invalid summaries instead of injecting them blindly
- Detect known legacy/mixed store patterns and expose them in status
- Support safe regeneration of current artifacts from current sources where possible
- Do not adopt a Codex-style global memory root

### Acceptance criteria

- old-format summaries are not injected
- current summaries are injected
- stale summaries older than current sources are skipped
- status reports mixed legacy/current stores clearly

### Verification

```bash
rtk vitest run test/memory-artifacts.test.ts test/extension.test.ts test/tools.test.ts
rtk npm run verify
```

---

## Phase 4 — Stage 1 quality gate for durable memory

### Goal

Reduce branch/task/process-heavy memory and preserve only future-useful project knowledge.

### Key files

- `src/stage1.ts`
- `src/prompts.ts`
- `src/memory-artifacts.ts`
- `test/stage1.test.ts`
- `test/memory-artifacts.test.ts`
- `test/consolidation.test.ts`

### Changes

- Tighten Stage 1 instructions so the model rejects:
  - transient branch narration
  - “what I just did” process summaries
  - phase/task bookkeeping unless it implies a durable convention or landmine
- Add local validation before persisting Stage 1 output
- Add a clearer quality outcome such as `rejected-low-quality`
- Treat rejected low-quality output as “no durable memory” rather than promoting junk
- Keep `memory_summary.md` compact and routing-focused

### Acceptance criteria

- process-only evidence does not become persisted memory
- real architecture/convention/command knowledge still promotes
- logs distinguish model failure from deliberate no-durable-memory / low-quality rejection

### Verification

```bash
rtk vitest run test/stage1.test.ts test/memory-artifacts.test.ts test/consolidation.test.ts
rtk npm run verify
```

---

## Why this beats the alternatives

### Better than minimal string/status patches

Minimal patches would improve wording while leaving the pipeline fragile:

- backlog overflow would recur
- evidence could still accumulate invisibly
- stale summaries could still be injected
- users would still struggle to tell capture from promotion failure

This plan fixes the operational path end-to-end.

### Better than a full Codex global-memory clone

A full clone would fight the product’s intended scope:

- `pi-project-memory` is deliberately project-scoped
- global selection increases irrelevance and cross-project bleed risk
- the current pain is local pipeline reliability, not missing global retrieval

The right move is to adopt Codex’s **separation and validation ideas**, not its **global storage semantics**.

## Recommended next implementation wave

Start with **Phase 1 + Phase 2 together** if the slice stays manageable.

Why:

- Phase 1 removes the hard blocker
- Phase 2 makes the system diagnosable immediately after that
- together they produce the biggest dogfood improvement fastest

Then do:

- **Phase 3** to stop stale injection and expose mixed-store issues
- **Phase 4** to improve memory quality once the pipeline is operationally trustworthy

## Dogfood checkpoint after implementation

After landing the first wave, repeat a short live audit on:

- `dumber`
- `pi-prompt-gen`
- `tmux-session-sidebar`
- `wl-clipboard-ssh-relay`
- `pi-project-memory`

Success looks like:

- no backlog hard-stop
- visible promotion/skip reasons
- no stale summary injection
- no silent mixed-store confusion
- at least one previously evidence-only repo promoting into usable memory
