import { afterEach, describe, expect, test } from 'bun:test'

import autofixPr from 'src/commands/autofix-pr/index.js'
import copy from 'src/commands/copy/index.js'
import memory from 'src/commands/memory/index.js'
import plugin from 'src/commands/plugin/index.js'
import provider from 'src/commands/provider/index.js'
import review from 'src/commands/review.js'
import { registerUpdateConfigSkill } from 'src/skills/bundled/updateConfig.js'
import { clearBundledSkills, getBundledSkills } from 'src/skills/bundledSkills.js'

// These commands parse arguments, and without an `argumentHint` the prompt
// shows nothing after `/name ` (useTypeahead.tsx sets the dimmed hint from it).
// The values are copied from each command's own parser, named beside it.
afterEach(() => {
  clearBundledSkills()
})

describe('argumentHint on commands that take arguments', () => {
  test.each([
    // commands/plugin/parseArgs.ts
    ['plugin', plugin, '[install|manage|uninstall|enable|disable|validate|marketplace]'],
    // commands/provider/provider.tsx: `migrate`, `doctor`, help aliases
    ['provider', provider, '[migrate [--force]|doctor|help]'],
    // commands/memory/tidy.ts SUBCOMMANDS
    ['memory', memory, '[tidy|sort|global|private|team]'],
    // commands/copy/copy.tsx: `/copy N`
    ['copy', copy, '[N]'],
    // commands/autofix-pr/index.ts parseArgs: `--dry-run` + free text
    ['autofix-pr', autofixPr, '[--dry-run] [extra instructions]'],
    // commands/review.ts: optional PR number
    ['review', review, '[pr-number]'],
  ] as const)('/%s advertises its arguments', (_name, command, hint) => {
    expect(command.argumentHint).toBe(hint)
  })

  test('the update-config skill advertises its free-text request', () => {
    registerUpdateConfigSkill()
    const skill = getBundledSkills().find(c => c.name === 'update-config')
    expect(skill?.argumentHint).toBe('[what to configure]')
  })
})
