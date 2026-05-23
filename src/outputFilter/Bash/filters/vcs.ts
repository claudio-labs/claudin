// Alternative VCS filters — Phase 12.3.
// Covers glab (GitLab), gt (Graphite), jj (Jujutsu). These tools share a
// "structured listing" shape that we can normalize with a small, family-
// shaped FilterSpec (cap line count, collapse blanks, strip ANSI).
//
// Regex are declared at module level — see .claudio/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- glab pr/mr/issue list -------------------------------------------------

const GLAB_LIST_MATCH = /^glab\s+(?:pr|mr|issue)\s+list\b/
// `--output json` / `-F json` already structured — keep raw.
const GLAB_LIST_REJECT = /(?:^|\s)(?:--output(?:=|\s+)json|-F(?:=|\s+)json|--per-page|--all)\b/

export const glabList: FilterSpec = {
  name: 'glab-list',
  matchCommand: GLAB_LIST_MATCH,
  matchCommandReject: GLAB_LIST_REJECT,
  stripAnsi: true,
  maxLines: 80,
  collapseRuns: true,
}

// --- gt (Graphite) ---------------------------------------------------------

// `gt log`, `gt ls`, `gt submit`, `gt sync`, `gt restack`. All print stacks of
// branches; deep stacks > 80 lines almost always have the same shape repeated.
const GT_MATCH = /^gt\s+(?:log|ls|submit|sync|restack)\b/

export const gt: FilterSpec = {
  name: 'gt',
  matchCommand: GT_MATCH,
  stripAnsi: true,
  maxLines: 80,
  collapseRuns: true,
}

// --- jj (Jujutsu) ----------------------------------------------------------

// `jj log`, `jj status` (alias `jj st`), `jj diff`. These mirror git's shape;
// long histories truncate the same way.
const JJ_MATCH = /^jj\s+(?:log|st|status|diff)\b/

export const jj: FilterSpec = {
  name: 'jj',
  matchCommand: JJ_MATCH,
  stripAnsi: true,
  maxLines: 80,
  collapseRuns: true,
}
