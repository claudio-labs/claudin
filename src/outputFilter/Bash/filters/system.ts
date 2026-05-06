// System-inspection filters: ps aux, top.
//
// Both are dominated by kernel threads (VIRT/RSS=0) that are rarely relevant
// to a coding agent. We strip those plus cap max lines, keeping the header
// and real user-space processes.
//
// Regex are declared at module level — see .claude/rules/typescript-patterns.md #3.

import type { FilterSpec } from '../types.js'

// --- ps aux --------------------------------------------------------------

const PS_AUX_MATCH = /^ps\s+(?:aux|-ef|auxf|aufx)\b/
// Kernel thread rows in `ps aux` output:
//   USER  PID  %CPU  %MEM  VSZ=0  RSS=0  TTY=?  STAT  START  TIME  [cmd]
// The defining signals are VSZ=0 *and* RSS=0 *and* the command in brackets.
const PS_KTHREAD_LINE =
  /^\S+\s+\d+\s+\d+\.\d\s+\d+\.\d\s+0\s+0\s+\?\s+\S+\s+\S+\s+\S+\s+\[[^\]]+\]\s*$/

export const psAux: FilterSpec = {
  name: 'ps-aux',
  matchCommand: PS_AUX_MATCH,
  stripLinesMatching: [PS_KTHREAD_LINE],
  // The header + top user processes are the signal. 50 lines comfortably
  // covers a reasonable laptop/server even after stripping kthreads.
  maxLines: 50,
}

// --- top -bn1 ------------------------------------------------------------

const TOP_MATCH = /^top\s+(?:-b|-n\s*1|-bn1)\b/
// Kernel-thread rows in `top` use VIRT=RES=SHR=0. Be strict: match the
// exact triple-zero middle columns to avoid eating real processes that
// just happen to have zero CPU%.
//   PID USER PR NI VIRT=0 RES=0 SHR=0 S %CPU %MEM TIME+ COMMAND
const TOP_KTHREAD_LINE =
  /^\s*\d+\s+\S+\s+\S+\s+\S+\s+0\s+0\s+0\s+\S\s/

export const top: FilterSpec = {
  name: 'top',
  matchCommand: TOP_MATCH,
  stripLinesMatching: [TOP_KTHREAD_LINE],
  // top's header is 5-7 lines + column header; cap at 60 to cover header
  // and the ~50 busiest user processes.
  maxLines: 60,
}
