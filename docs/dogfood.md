# Dogfood notes

Dogfooded on this repository (`pi-project-memory`) as the real project under active development.

## Checks run

- `npm run verify` — typecheck and full Vitest suite.
- `npm audit --audit-level=critical` — no critical vulnerabilities.
- `npm pack --dry-run` — package contents are packable.

## Failure cases covered by tests

- Missing `origin` remote falls back to path-scoped memory.
- Unsupported local remotes fall back to path-scoped memory.
- SSH and HTTPS aliases for the same GitHub source resolve to shared memory.
- Changed remote URL preserves aliases and memory root when canonical source is unchanged.
- Fork/upstream remotes remain distinct.
- Invalid project ids cannot escape storage roots.
- Concurrent lock contenders serialize; dead-owner locks recover; malformed owner locks fail closed.
- Reset requires confirmation and refuses headless destructive deletion.
- Model auth unavailable falls back without calling a model.
- Headless confirmation-required removals remain pending.
- Budget exhaustion preserves pending events.
- Concurrent automatic updates are serialized and disable cancels queued/pre-commit work.
