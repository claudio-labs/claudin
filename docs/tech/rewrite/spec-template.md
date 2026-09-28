# Spec: `<slice>/<module>`

<!--
Copy to docs/tech/rewrite/<slice>/<module>.md before the removal commit.

The implementer reads this, the tests, and the project's own code, and never
the old implementation. So this page describes WHAT the module does, as seen
from outside, and nothing about HOW the old one did it:

- no code, no pseudo-code that mirrors the old control flow;
- no internal names (private functions, local types, module-level constants);
- no internal structure (which helper calls which, in what order, in what file).

Exported names and types stay, because callers not yet rewritten depend on them
(README.md, "Contracts during the transition").
-->

## Purpose

One paragraph: what the module is for, and who calls it.

## Public contract

Every export another module imports today, with its signature. List the
callers with `Grep`: `from 'src/<slice>/<module>`.

| Export | Signature | Used by |
|---|---|---|
| | | |

## Observable behaviour

Inputs, outputs, side effects (files, processes, network, settings, UI). One
entry per behaviour, each phrased so that a test could check it.

## Edge cases and errors

Empty input, missing files, malformed data, timeouts, concurrency, platform
differences. For each: what the caller sees.

## Tests that pin it

The characterization suite written for this rewrite, plus the existing tests
that exercise the module through its contract. List the break-probe spec that
proves they guard it: `scripts/migrations/probes/rewrite-<module>.json`.

## Out of scope

Behaviour the old module had that the rewrite drops on purpose, and why.

## Target design

How the new module should be shaped, in this project's terms: the vertical
slice layout, the responsibilities split along SOLID lines, and the types to
make explicit. See `.claudin/rules/code-design.md`.
