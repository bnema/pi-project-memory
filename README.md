# pi-project-memory

Keep project-scoped local memory for Pi outside the repository.

## What it does

- Stores structured memory records (extraction results and manual notes) per Git project, deterministically rendered into MEMORY.md and memory_summary.md.
- Keys memory by canonical Git source when possible.
- Adds commands for status, open, checkpointing, updating, enable/disable auto mode, and reset.
- Adds tools for reading, searching, and adding approved notes.
- Keeps stored text size-capped, secret-redacted, and framed as untrusted project data.

## Install

```bash
pi install git:github.com/bnema/pi-project-memory
```

## Commands

```text
/project-memory status
/project-memory open
/project-memory checkpoint
/project-memory update
/project-memory enable-auto
/project-memory disable-auto
/project-memory reset
```

## Tools

- `project_memory_status`
- `project_memory_read`
- `project_memory_search`
- `project_memory_note`

## Storage and safety

Default storage lives outside repositories:

```text
~/.pi/agent/project-memory/by-remote/<projectId>/
```

Set `PI_PROJECT_MEMORY_ROOT` to use another location. Captured evidence is size-capped and secret-redacted. Generated memory is escaped and framed as untrusted project data. Automatic updates are enabled by default and can be disabled.

## Develop

```bash
npm install
npm run verify
pi -e .
```
