// Guards on SPEC_COMMANDS. Between them they make the table a description of
// the registry rather than a snapshot that drifts from it: a spec added without
// an entry fails, an entry naming a spec that no longer exists fails, and a
// command that stops routing to its own spec fails.
//
// The third is the one that does real work. Matching `matchCommand` is not
// enough — a command has to survive the WHOLE registry, in order, with every
// `matchCommandReject` applied. When it fails, fix the command; reordering
// `builtInFilters` to make a test pass would change production routing.

import { describe, expect, test } from 'bun:test'

import { builtInFilters } from 'src/tools/shared/outputFilter/Bash/filters/index.js'
import { SPEC_COMMANDS } from 'src/tools/shared/outputFilter/Bash/filters/__testutils__/specCommands.js'
import { findFilterForCommand } from 'src/tools/shared/outputFilter/Bash/registry.js'

const registeredNames = builtInFilters.map(f => f.name)

describe('SPEC_COMMANDS', () => {
  test('covers every registered spec', () => {
    const missing = registeredNames.filter(name => !(name in SPEC_COMMANDS))
    // Name them: a bare count tells you a spec was added but not which one.
    expect(missing).toEqual([])
  })

  test('names no spec that is not registered', () => {
    const known = new Set(registeredNames)
    const orphans = Object.keys(SPEC_COMMANDS).filter(name => !known.has(name))
    expect(orphans).toEqual([])
  })

  test('every command routes to its own spec', () => {
    const misrouted = Object.entries(SPEC_COMMANDS)
      .map(([name, command]) => ({
        name,
        command,
        routedTo: findFilterForCommand(command)?.name ?? null,
      }))
      .filter(row => row.routedTo !== row.name)
    expect(misrouted).toEqual([])
  })

  test('the registry has no duplicate spec names', () => {
    // A duplicate would make `SPEC_COMMANDS` ambiguous and the routing test
    // pass for whichever copy the registry reaches first.
    const seen = new Set<string>()
    const duplicates = registeredNames.filter(name => {
      if (seen.has(name)) return true
      seen.add(name)
      return false
    })
    expect(duplicates).toEqual([])
  })
})
