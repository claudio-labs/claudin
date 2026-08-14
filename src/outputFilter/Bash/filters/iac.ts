// IAC filters: terraform / tofu plan, apply, destroy, state list.
//
// terraform plan (no-changes): output is almost entirely "Refreshing state..."
// lines (one per managed resource), state-lock acquire/release, and a final
// "No changes." sentence.  In large environments this can be hundreds of lines
// for a plan that changes nothing.  We strip the noise and collapse to a
// one-line sentinel.
//
// terraform plan (with changes): the resource diff is pure signal — we only
// strip the lock/refresh prefix and blank lines, then leave the diff intact.
//
// terraform apply: "Still creating... [Xs elapsed]" lines repeat every 10 s
// per resource for the entire provisioning duration.  We strip them but keep
// "Creation complete after Ns" (one line per resource, real signal).  On a
// clean apply we collapse to a sentinel; Outputs: section is always preserved.
//
// -json passthrough: structured JSON output is consumed by tooling; filtering
// would corrupt it.
//
// Regex are declared at module level — see .claudin/rules/typescript-patterns.md #3.

import type { FilterSpec } from 'src/outputFilter/Bash/types.js'

const TF_STRIP_ACQUIRING = /^Acquiring state lock\./
const TF_STRIP_RELEASING = /^Releasing state lock\./
const TF_STRIP_REFRESHING = /^Refreshing state\.\.\./
// "Still creating/destroying/modifying... [Ns elapsed]" — repeats every 10 s.
// The form without a timer ("aws_instance.web: Creating...") is 1 line per
// resource and stays as signal.
// Resource addresses can include indexed notation: module.vpc.aws_subnet.private[0].
// Use [^:]* (everything before the colon) instead of [\w.-]* to cover all forms.
const TF_STRIP_STILL_POLLING = /^\S[^:]*: Still (?:creating|destroying|modifying)\.\.\. \[/
const TF_STRIP_BLANK = /^\s*$/

// "No changes." is the common prefix for both plan ("...Your infrastructure
// matches the configuration.") and destroy ("...No objects need to be
// destroyed.") outcomes.  Matching the prefix covers both forms.
const TF_NO_CHANGES = /^No changes\./m
const TF_APPLY_DONE = /^Apply complete! Resources: /m
// Error blocks use box-drawing characters (╷ │ ╵) or plain "Error:".
const TF_HAS_PROBLEM = /^\s*[│|]\s+Error:|^Error:|^╷/m

const TF_MATCH = /^(terraform|tofu|tf)\s+(plan|apply|destroy|state\s+list)\b/
// -json / --json produces structured output consumed by tooling — never filter.
const TF_REJECT = /(?:^|\s)--?json\b/

export const terraform: FilterSpec = {
  name: 'terraform',
  matchCommand: TF_MATCH,
  matchCommandReject: TF_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    TF_STRIP_ACQUIRING,
    TF_STRIP_RELEASING,
    TF_STRIP_REFRESHING,
    TF_STRIP_STILL_POLLING,
    TF_STRIP_BLANK,
  ],
  matchOutput: [
    {
      pattern: TF_NO_CHANGES,
      unless: TF_HAS_PROBLEM,
      message: '✓ terraform: no changes',
    },
    {
      pattern: TF_APPLY_DONE,
      unless: TF_HAS_PROBLEM,
      message: '✓ terraform: apply complete',
    },
  ],
  maxLines: 200,
  truncateLineAt: 500,
}
