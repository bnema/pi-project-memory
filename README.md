# pi-project-memory

Keep project-scoped local memory for Pi outside the repository.

## What it does

- Stores a small handbook per Git project: facts, conventions, commands, decisions, and stale notes.
- Keys memory by canonical Git source when possible.
- Adds commands for status, checkpointing, updating, verification, and reset.
- Adds tools for reading, searching, and adding approved notes.
- Keeps stored text size-capped, secret-redacted, and framed as untrusted project data.

## Install

```bash
pi install git:github.com/bnema/pi-project-memory
```

## Use

```text
/project-memory status
/project-memory open
/project-memory checkpoint
/project-memory update
/project-memory verify
/project-memory enable-auto
/project-memory disable-auto
```

Tools:

- `project_memory_status`
- `project_memory_read`
- `project_memory_search`
- `project_memory_note`

## Storage

```text
~/.pi/agent/project-memory/by-remote/<projectId>/
```

## Develop

```bash
npm install
npm run verify
pi -e .
```
