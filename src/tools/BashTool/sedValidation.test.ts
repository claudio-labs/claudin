import { describe, expect, test } from 'bun:test'

import { getEmptyToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import {
  checkSedConstraints,
  extractSedExpressions,
  hasFileArgs,
  sedCommandIsAllowedByAllowlist,
} from 'src/tools/BashTool/sedValidation.js'

/** Narrows to the ask branch and hands back the message it carries. */
function askMessage(result: PermissionResult): string {
  if (result.behavior !== 'ask') {
    throw new Error(`expected an ask decision, got '${result.behavior}'`)
  }
  return result.message
}

describe('extractSedExpressions', () => {
  test('returns the expression whether it is positional or behind -e', () => {
    expect(extractSedExpressions("sed 's/a/b/' file.txt")).toEqual(['s/a/b/'])
    expect(extractSedExpressions("sed -e 's/a/b/' file.txt")).toEqual([
      's/a/b/',
    ])
    expect(extractSedExpressions("sed --expression='s/a/b/' file.txt")).toEqual([
      's/a/b/',
    ])
  })

  test('throws on the fused -e/-w flag combinations that hide a write', () => {
    expect(() => extractSedExpressions("sed -ew 's/a/b/' out")).toThrow()
    expect(() => extractSedExpressions("sed -we 's/a/b/' out")).toThrow()
  })
})

describe('hasFileArgs', () => {
  test('distinguishes a stdin filter from one that names files', () => {
    expect(hasFileArgs("sed 's/a/b/'")).toBe(false)
    expect(hasFileArgs("sed 's/a/b/' file.txt")).toBe(true)
    // With -e, every non-flag argument is a file.
    expect(hasFileArgs("sed -e 's/a/b/' file.txt")).toBe(true)
  })

  test('counts a glob as a file argument', () => {
    expect(hasFileArgs("sed 's/a/b/' *.log")).toBe(true)
  })
})

describe('sedCommandIsAllowedByAllowlist', () => {
  test('allows line printing and a plain stdin substitution', () => {
    expect(sedCommandIsAllowedByAllowlist("sed -n '1,10p' file.txt")).toBe(true)
    expect(sedCommandIsAllowedByAllowlist("sed 's/a/b/'")).toBe(true)
  })

  // Two independent layers reject these — the allowlist patterns never match
  // them, and the denylist catches them anyway. This pins the outcome, not
  // either layer: removing just one of the two keeps it green.
  test('rejects the w/e commands that write or execute', () => {
    expect(sedCommandIsAllowedByAllowlist("sed 's/a/b/w /tmp/out' f")).toBe(
      false,
    )
    expect(sedCommandIsAllowedByAllowlist("sed 's/a/b/e' f")).toBe(false)
  })

  test('only allows an in-place edit when file writes are opted into', () => {
    expect(sedCommandIsAllowedByAllowlist("sed -i 's/a/b/' f.txt")).toBe(false)
    expect(
      sedCommandIsAllowedByAllowlist("sed -i 's/a/b/' f.txt", {
        allowFileWrites: true,
      }),
    ).toBe(true)
  })
})

describe('checkSedConstraints', () => {
  const defaultContext = getEmptyToolPermissionContext()
  const acceptEditsContext = {
    ...getEmptyToolPermissionContext(),
    mode: 'acceptEdits' as const,
  }

  test('ignores commands that are not sed', () => {
    expect(
      checkSedConstraints({ command: 'ls -la' }, defaultContext).behavior,
    ).toBe('passthrough')
  })

  test('asks for a dangerous sed anywhere in a compound command', () => {
    const result = checkSedConstraints(
      { command: "ls && sed 's/a/b/e' f" },
      defaultContext,
    )
    expect(askMessage(result)).toContain('sed command requires approval')
  })

  // The mode gate is the whole point of this check: acceptEdits buys `-i`,
  // it does not buy the write/execute commands.
  test('acceptEdits allows -i but still blocks write and execute commands', () => {
    expect(
      checkSedConstraints({ command: "sed -i 's/a/b/' f.txt" }, defaultContext)
        .behavior,
    ).toBe('ask')
    expect(
      checkSedConstraints(
        { command: "sed -i 's/a/b/' f.txt" },
        acceptEditsContext,
      ).behavior,
    ).toBe('passthrough')
    expect(
      checkSedConstraints(
        { command: "sed -i 's/a/b/w /tmp/out' f.txt" },
        acceptEditsContext,
      ).behavior,
    ).toBe('ask')
  })
})
