# pi-project-memory

Project-scoped local memory for Pi.

It keeps a small, local handbook for each Git project: facts, conventions, useful commands, decisions, and stale notes. Memory is stored outside the repo and keyed by the project remote when possible.

## Install

```bash
npm install
npm run verify
pi -e /path/to/pi-project-memory
```

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

## Tools

- `project_memory_status`
- `project_memory_read`
- `project_memory_search`
- `project_memory_note`

## Storage

Default storage lives outside repositories:

```text
~/.pi/agent/project-memory/by-remote/<projectId>/
```

Set `PI_PROJECT_MEMORY_ROOT` to use another location.

## Safety

- no raw transcript, full command output, full diff, `.env`, or environment dump is stored by default
- captured text is size-capped and secret-redacted
- generated prompt memory is escaped and framed as untrusted project data
- automatic updates are idle-gated, budgeted, and can be disabled
- facts can be marked stale when related files change

## License

MIT
