# Contributing to Claudin

Thanks for contributing — and we mean it: **every contribution is welcome and is reviewed with real dedication**, from a one-line typo fix to a whole new provider. If you take the time to open a thread or a PR, we take the time to engage with it properly and help it land.

Claudin is a fast-moving open-source coding-agent CLI with support for multiple providers, local backends, MCP, and a terminal-first workflow. The best contributions here are focused, well-tested, and easy to review.

## Before You Start

Pick the right kind of thread first — it keeps review fast and fair:

- **Small, self-contained fixes** (a bug fix, a doc tweak, a single provider adjustment) — open a **PR** directly.
- **Confirmed bugs** — open an **Issue** with a clear reproduction. For **critical bugs** (crashes, data loss, broken publish/auth, privacy or security regressions), opening an Issue is strongly encouraged so the problem is tracked and prioritized — even when you also send the fix in the same PR.
- **Larger or structural changes** — discuss first; see [Larger Changes: Discuss First](#larger-changes-discuss-first).
- **Setup help, ideas, and general questions** — use **Discussions**.
- **Security reports** — follow [SECURITY.md](SECURITY.md); please do not open a public issue for these.

## Larger Changes: Discuss First

Some changes need alignment *before* code, because they affect everyone building on top of Claudin or hinge on measurable trade-offs. Open a **GitHub Discussion** first for:

- **Layout / structural changes** — moving modules, reorganizing the build, renaming public surfaces, restructuring the TUI.
- **Large features** — new subsystems, new tools, or anything that spans many files or adds a new user-facing mode.
- **Cache, token-efficiency, and performance work** — anything that claims to make Claudin faster, cheaper, or lighter.

For performance, efficiency, and cache changes an approach is not enough on its own: **bring benchmark evidence of the improvement, in the same style as the benches already in the repo.** Reuse or extend the existing harnesses instead of inventing an ad-hoc measurement:

- `scripts/bench/ab/` — head-to-head benchmarks, where two or more arms are compared (`cache-ab-bench.ts`, `cache-lockstep-bench.ts`, `agent-bg-token-bench.ts`, `typecheck-ab.ts`).
- `scripts/bench/perf/` — latency, memory and heap (`cold-start-bench.ts`, `memory-turn-by-turn-bench.ts`); see `scripts/bench/perf/README.md`.
- `scripts/bench/tokens/measure-*.test.ts` — measurement tests that assert a budget or ROI for a single state (`measure-bash-filter-roi.test.ts`, `measure-token-budget.test.ts`, `measure-cache-invalidation-budget.test.ts`, etc.).
- `bun run test:coverage` (+ `scripts/codegen/render-coverage-heatmap.ts`) for coverage deltas.

`scripts/README.md` has the directory-by-directory map, including which of the three a new bench belongs in.

A good performance PR states the before/after numbers, the exact command that produced them, and the machine/conditions — the way the write-ups in `docs/tech/` and `src/agent/cache/README.md` do. Numbers without a reproducible command are hard to accept.

Discussing first is not a barrier — it is how we make sure your effort lands. Maintainers will engage with real dedication to help shape the change so it can merge.

## Local Setup

Install dependencies:

```bash
bun install
```

Build the CLI:

```bash
bun run build
```

Smoke test:

```bash
bun run smoke
```

Run the app locally:

```bash
bun run dev
```

### Two binaries: `claudin` and `claudindev`

Keep the published release usable while you iterate on unreleased work by putting
both on your `$PATH`:

- **`claudin`** — the globally installed npm package (`@claudiolabs/claudin`),
  updated only by `bun install -g @claudiolabs/claudin`.
- **`claudindev`** — a symlink to `<repo>/bin/claudin`, created by
  `bun run link:dev` (into `~/.bun/bin` or `~/.local/bin`). It always runs the
  latest `bun run build` output (`dist/cli.mjs`) from your checkout.

If a feature you just built "doesn't show up", check which one you launched:
source changes only take effect under `claudindev`, and only after
`bun run build`. `claudin` stays on the pinned release no matter what the repo
looks like.

If you are working on provider setup or saved profiles, configure profiles from inside the REPL with `/provider` and validate the active profile with `/provider doctor`. The provider integration tests run via:

```bash
bun run test:provider
```

## Development Workflow

- Keep PRs focused on one problem or feature.
- Avoid mixing unrelated cleanup into the same change.
- Preserve existing repo patterns unless the change is intentionally refactoring them.
- Add or update tests when the change affects behavior.
- Update docs when setup, commands, or user-facing behavior changes.

## Validation

At minimum, run the most relevant checks for your change.

Common checks:

```bash
bun run build
bun run smoke
```

Focused tests:

```bash
bun test ./path/to/test-file.test.ts
```

When working on provider/runtime setup, run `/provider doctor` from inside Claudin to probe the active profile (reachability, auth, and model availability).

## Pull Requests

Good PRs usually include:

- a short explanation of what changed
- why it changed
- the user or developer impact
- the exact checks you ran

If the PR touches UI or terminal presentation, include screenshots when useful.

If the PR changes provider behavior, mention which provider path was tested.

## Code Style

- Follow the existing code style in the touched files.
- Prefer small, readable changes over broad rewrites.
- Do not reformat unrelated files just because they are nearby.
- Keep comments useful and concise.

## Provider Changes

Claudin supports multiple provider paths. If you change provider logic:

- be explicit about which providers are affected
- avoid breaking third-party providers while fixing first-party behavior
- test the exact provider/model path you changed when possible
- call out any limitations or follow-up work in the PR description

## Community

Please be respectful and constructive with other contributors.

Maintainers may ask for:

- narrower scope
- focused follow-up PRs
- stronger validation
- docs updates for behavior changes

That is normal and helps keep the project reviewable as it grows.
