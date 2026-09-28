# Team memory

- [Tests hit a real database](conventions-real-database.md) — no mocks for the storage layer
- Release checklists, by quarter: [Q1](release-q1.md) · [Q2](release-q2.md)
  - Q2 replaced the manual smoke step with the scripted one

## Decisions
- [Git is the sync](decisions/git-is-the-sync.md) — the team dir is committed, never uploaded

## Bugs
- [Flaky lock test](bugs/flaky-lock.md) — races under load; held by a retry, not fixed

## Docs
- [Provider notes](docs/provider-docs.md) — start here before touching auth
