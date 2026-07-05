import { MAX_FINDINGS } from './constants.js'

export const DESCRIPTION = `Report code-review findings as a typed list so the host UI can render them.`

export const PROMPT = `Report code-review findings as a typed list so the host UI can render them (ranked, colored, as inline PR comments, with fix-outcome tracking) instead of parsing free-form prose.

This tool performs no side effect — no read, no edit, no shell. It exists purely so you hand back the findings of a review as a validated, machine-addressable list.

## When to call it

Use this tool ONLY when the active code-review instructions tell you to report findings with it; otherwise follow whatever output format those instructions specify. Do not call it on a plain inline review that asks for a different format.

## Contract

- Call it **once**, at the end of a review, with the whole ranked list — not once per finding.
- Rank findings **most-severe first**. Pass an empty array if nothing survived verification.
- Cap the list at ${MAX_FINDINGS} items — if more survive, keep the ${MAX_FINDINGS} most severe.
- **Do not also print the findings as text** — the tool call *is* the report, not a supplement to prose. The one exception is when the active review instructions explicitly ask for a headless text dump (e.g. a non-interactive \`-p\` run); then follow them.
- The three required per-finding fields (\`file\`, \`summary\`, \`failure_scenario\`) are the contract's teeth: a finding with no concrete \`failure_scenario\` — real inputs/state that lead to a wrong output or crash — does not get reported. A hunch is not a finding.
- Set \`verdict\` (\`CONFIRMED\` / \`PLAUSIBLE\`) only when a verify pass ran; omit it on inline-only reviews.
- When **re-reporting after applying fixes** (only if the apply step asks for it), set \`outcome\` on each finding to what actually happened (\`fixed\` / \`skipped\` / \`no_change_needed\`).`
