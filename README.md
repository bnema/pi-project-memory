# pi-project-memory

Project-scoped local memory for Pi: a generated, evidence-backed handbook of architecture, conventions, commands, workflows, and landmines for each Git project.

Memory is keyed by canonical Git source when possible and stored outside the repository. Prompt injection treats memory as untrusted project data, not instructions.

## Install locally

```bash
npm install
npm run verify
pi -e /path/to/pi-project-memory
```

The package declares Pi extension metadata in `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"] }
}
```

## Storage

Default storage:

```text
~/.pi/agent/project-memory/by-remote/<projectId>/
```

`projectId` is derived from the normalized Git `origin` remote when available. Repositories without a supported remote fall back to path-scoped memory. Set `PI_PROJECT_MEMORY_ROOT` to use a different storage root, including in tests.

Canonical files:

- `facts.jsonl` — source of truth.
- `MEMORY.md` — generated readable artifact.
- `memory_summary.md` — generated prompt summary.
- `pending-events.jsonl` — bounded explicit notes/checkpoints awaiting consolidation.
- `pending-confirmations.jsonl` — candidates requiring interactive approval.
- `usage.json`, `update-log.jsonl`, `auto-update.json`, `git-state.json` — maintenance/accounting state.

## Commands

```text
/project-memory status
/project-memory open
/project-memory checkpoint
/project-memory update
/project-memory verify [fact-id...]
/project-memory enable-auto
/project-memory disable-auto
/project-memory reset
```

- `checkpoint` captures a bounded pending event only.
- `update` captures a checkpoint and consolidates pending events.
- `verify` marks selected possibly-stale facts active again; with no IDs it verifies all stale facts.
- `enable-auto` turns on conservative high-signal automatic updates.
- `disable-auto` stops future automatic updates and cancels queued/pre-commit work.
- `reset` deletes project memory after interactive confirmation.

## Tools

Registered tools:

- `project_memory_status`
- `project_memory_read`
- `project_memory_search`
- `project_memory_note`

`project_memory_note` records explicit user-approved memory notes as pending events.

## Safety model

Defaults are conservative:

- storage is outside checked-out repositories;
- no raw transcript, full command output, full diff, full file content, environment dump, or `.env` content is stored by default;
- captured text is size-capped and secret-redacted;
- model consolidation is budgeted, idle-gated, and falls back when model auth is unavailable;
- normative/destructive/removal candidates require confirmation and fail closed headlessly;
- generated prompt memory is escaped and framed as untrusted project data;
- facts can be marked `possibly_stale` when Git changes match staleness triggers, and stale facts are excluded from the prompt summary.

## Automatic updates

Automatic updates run only when enabled and when a deterministic high-signal score is reached from structural evidence such as verified commands and edit/write tool usage. They are debounced, minimum-interval gated, idle-checked, lock-protected, and token-budgeted.

`session_shutdown` only flushes a bounded checkpoint. It does not perform long model calls.

## Troubleshooting

- **No memory appears:** run inside a Git repository, or check `/project-memory status`.
- **Path-scoped memory warning:** configure a supported non-local `origin` remote if clones/worktrees should share memory.
- **Model auth unavailable:** `/project-memory update` falls back to conservative local candidates.
- **Facts disappeared from summary:** they may be `possibly_stale`; run `/project-memory verify` after checking them.
- **Pending confirmations:** open the memory directory with `/project-memory open` and inspect `pending-confirmations.jsonl`.
- **Need a clean slate:** use `/project-memory reset` interactively.
