# pi-project-memory

Project-scoped local memory for Pi: a living handbook of architecture, conventions, commands, and landmines keyed by canonical Git source and stored outside the repository.

## Current status

Design/spec phase only. No implementation has been added yet.

The implementation plan now starts with a Pi API feasibility spike before automatic capture or model consolidation. The read-path MVP comes after that: project fingerprinting, local storage resolution, prompt injection, and safe search/read/status tools.

## Design docs

Canonical Markdown docs are in the local project notes:

- `spec.md` — product and technical specification
- `plan.md` — phased implementation plan

## Intended storage model

Default storage will be outside checked-out repositories:

```text
~/.pi/agent/project-memory/by-remote/<projectId>/
```

`projectId` is derived from the normalized canonical Git remote when available, so clones and worktrees of the same source share memory.

## Safety model

Planned defaults:

- memory content is prompt-injected only as explicitly untrusted project data;
- `facts.jsonl` is canonical, while `MEMORY.md` and `memory_summary.md` are generated views;
- no raw command output, full transcript, full file content, full diff, environment variable dump, or `.env` content is stored by default;
- automatic model consolidation is gated by high-signal scoring, idle checks, locks, and token budgets;
- normative conventions require confirmation, and headless modes leave them pending.

## Not implemented yet

Do not install this package expecting runtime behavior yet. The repo currently exists to hold the package skeleton and link to the Markdown-only design docs.
