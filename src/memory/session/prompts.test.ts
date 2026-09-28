/**
 * The default template's guidance lines are this project's own. The
 * characterization pins their shape; this pins that each one still says what
 * its section is for.
 */
import { expect, test } from 'bun:test'

import { DEFAULT_SESSION_MEMORY_TEMPLATE } from 'src/memory/session/prompts.js'

/** Each header, and what its guidance line has to ask for. */
const INTENTS: ReadonlyArray<readonly [header: string, asks: readonly RegExp[]]> = [
  ['# Session Title', [/title/i, /5-10/]],
  ['# Current State', [/right now/, /pending/, /next steps/]],
  ['# Task specification', [/asked to build/, /design decisions/, /context/]],
  ['# Files and Functions', [/files/, /holds/, /why/]],
  ['# Workflow', [/commands/, /order/, /output/]],
  ['# Errors & Corrections', [/fixed/, /corrected/, /not to try again/]],
  ['# Codebase and System Documentation', [/components/, /fit together/]],
  ['# Learnings', [/worked/, /did not/, /avoid/, /without repeating/]],
  ['# Key results', [/exact output/, /in full/]],
  ['# Worklog', [/step-by-step/, /tried/]],
]

test('every guidance line of the default template says what its section is for', () => {
  const lines = DEFAULT_SESSION_MEMORY_TEMPLATE.split('\n')
  for (const [header, asks] of INTENTS) {
    const guidance = lines[lines.indexOf(header) + 1] ?? ''
    for (const ask of asks) expect({ header, guidance }).toMatchObject({ guidance: expect.stringMatching(ask) })
  }
})
