# pi-project-memory

Project-scoped local memory for Pi: a living handbook of architecture, conventions, commands, and landmines keyed by canonical Git source and stored outside the repository.

## Current status

Early implementation. The package currently contains the Pi package skeleton and the first read-path modules. Automatic capture and model consolidation are intentionally deferred until the API spike is documented.

## Install locally

From this repository:

```bash
npm install
npm run verify
pi -e /path/to/pi-project-memory
```

The package is also shaped for Pi package loading via `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": { "extensions": ["./extensions"] }
}
```

## Implemented first

- package manifest for Pi extension discovery;
- TypeScript project and Vitest setup;
- extension entrypoint at `extensions/project-memory.ts`;
- initial modules for project identity, storage, commands, tools, prompts, and shared types.

## Intended storage model

Default storage is outside checked-out repositories:

```text
~/.pi/agent/project-memory/by-remote/<projectId>/
```

`projectId` is derived from the normalized canonical Git remote when available, so clones and worktrees of the same source share memory. Repositories without a remote fall back to path-scoped memory.

## Safety model

Defaults are conservative:

- memory content is prompt-injected only as explicitly untrusted project data;
- `facts.jsonl` is canonical, while `MEMORY.md` and `memory_summary.md` are generated views;
- no raw command output, full transcript, full file content, full diff, environment variable dump, or `.env` content is stored by default;
- automatic model consolidation is gated by high-signal scoring, idle checks, locks, and token budgets;
- normative conventions require confirmation, and headless modes leave them pending.

## Design docs

The product specification and implementation plan live in the project planning notes outside this repository. The README describes the current package behavior rather than embedding local machine paths.
