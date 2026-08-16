# ReportFindings (typed code-review output)

**Status: not yet in claudin.** There is no `ReportFindings` tool under `src/tools/`. claudin's
`/code-review` skill (`src/skills/bundled/code-review.ts`) already produces findings with the
same *shape* — but as a **JSON array printed as model text**, not as a validated tool call the
host renders. This doc specifies the tool as it ships in upstream Claude Code 2.1.201, so it can
be ported. Proposed paths below are not present yet.

`ReportFindings` is a **structured-output tool for code review**. It performs no side effect —
no read, no edit, no shell — it exists purely so the model *hands back* the findings of a review
as a typed list, which the host UI renders (ranked, colored, as inline PR comments, with
fix-outcome tracking) instead of parsing free-form prose.

## The problem

claudin's review skill today ends with an `## Output` section that instructs the model to
"Return findings as a JSON array of at most N objects" (`code-review.ts:290`). That works, but a
free-text JSON blob has three weaknesses:

| Free-text JSON | Consequence |
|---|---|
| Not schema-validated at the boundary | A missing field or a malformed array is only caught (if at all) by whatever parses the text downstream — the model isn't asked to retry. |
| Not machine-addressable | The host can't reliably render it as ranked cards or post each finding as an inline comment without re-parsing prose that may be wrapped in explanation. |
| No structured fix-tracking | After `--fix`, "what happened to each finding" is prose, not a field. |

A typed tool closes all three: validation happens at the tool-call layer (the model is forced to
call the tool and **retries on schema mismatch**), and the result is a clean object the UI owns.

## What it does

One tool call, once, at the end of a review. The payload:

| Field | Req? | Meaning |
|---|---|---|
| `findings[]` | ✓ | The verified findings, **ranked most-severe first**; empty array if nothing survived verification. Capped at **32 items**. |
| `findings[].file` | ✓ | Repo-relative path the finding is in. |
| `findings[].summary` | ✓ | One-sentence statement of the defect. |
| `findings[].failure_scenario` | ✓ | Concrete inputs/state → wrong output/crash. This is what separates a real bug from a hunch. |
| `findings[].line` | — | 1-indexed line the finding anchors to. |
| `findings[].category` | — | Kebab-case slug (≤40 chars): `correctness`, `simplification`, `efficiency`, `test-coverage`, … |
| `findings[].verdict` | — | `CONFIRMED` or `PLAUSIBLE` — set when a verify pass ran; absent on inline-only reviews. |
| `findings[].outcome` | — | Set **only** when re-reporting after `--fix`: `fixed` / `skipped` / `no_change_needed`. |
| `level` | — | Effort the review ran at: `low` / `medium` / `high` / `xhigh` / `max`. |

The three required per-finding fields (`file`, `summary`, `failure_scenario`) are the contract's
teeth: a finding with no concrete `failure_scenario` doesn't get to be reported.

### Contract

- Call it **once**, with the whole ranked list — not once per finding.
- Rank **most-severe first**; empty array when nothing survived verification.
- **Do not also print the findings as text.** It's the tool or prose, never both.
- Only call it when the active review instructions tell you to. On a plain inline review that
  asks for a different format, follow that instead.
- When re-reporting after applying fixes (only if the apply step asks), set `outcome` on each
  finding to what actually happened.

## What claudin already has vs. what the tool adds

claudin's `/code-review` skill is close in spirit — it already ships the pieces the tool would
formalize:

- The **field set** matches (`file`, `line`, `summary`, `failure_scenario`), emitted as JSON at
  `code-review.ts:290-306`.
- The **verdict ladder** (`CONFIRMED` / `PLAUSIBLE`) is already defined (`VERDICT_LADDER`,
  `code-review.ts:232`) with the "PLAUSIBLE by default, don't refute for being speculative" recall
  rule.
- **Most-severe-first ranking** and per-level caps (≤4 / ≤8 / ≤10 / ≤15) already exist.
- **Inline PR comments** already happen via `--comment` (`gh api …/pulls/{pr}/comments`,
  `code-review.ts:427`).

So porting `ReportFindings` is **not new review logic** — it's promoting the existing JSON
`## Output` contract from *model-emitted text* to a *validated tool call*:

1. The model is forced to call the tool, so the boundary retries on a malformed payload instead of
   shipping broken JSON.
2. The host renders the typed result directly (ranked cards, `--comment` posting, `outcome`
   badges) without re-parsing prose.

## How it would land in claudin

- **Tool.** Add `src/tools/ReportFindingsTool/` — a zod schema mirroring the table above and a
  short prompt (the contract). The `execute` handler is nearly a no-op: validate and return the
  list to the host for rendering. Budget the schema against
  `scripts/bench/tokens/measure-tool-schemas.test.ts`.
- **Wire the skill.** Change the `## Output` section of `src/skills/bundled/code-review.ts` from
  "return a JSON array" to "call `ReportFindings` once with the ranked list", keeping the field
  names and verdict ladder identical so behavior is unchanged.
- **Pairs with workflows.** The review→verify workflow shape in
  `docs/features/workflows.md` produces exactly this list; `ReportFindings` is its natural sink.

## References

- Upstream reference: Claude Code 2.1.201 `ReportFindings` tool (schema + prompt).
- claudin today: `src/skills/bundled/code-review.ts` (`## Output` JSON contract, `VERDICT_LADDER`,
  `--comment` posting), `src/skills/bundled/simplify.ts`.
- Related: `docs/features/workflows.md`.
