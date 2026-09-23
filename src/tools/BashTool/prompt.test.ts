// Tests for BashTool prompt assembly: the git-instructions toggle, the
// extracted body builder, and the simple-prompt rendering.
//
// Note on `ANTHROPIC_API_KEY` stubbing in the body tests: `getBashGitInstructionsBody()`
// calls `getAttributionTexts()` (src/vcs/git/attribution.ts), which routes
// through model resolution and demands an API key even for these
// read-only string assertions. The stub is load-bearing — without it the
// tests blow up at import-resolution time.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { getAttributionTexts } from 'src/vcs/git/attribution.js'
import { parseGitCommand } from 'src/tools/GitTool/grammar.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import {
  getSimplePrompt,
  shouldInjectBashGitInstructionsInMessages,
} from 'src/tools/BashTool/prompt.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'

describe('shouldInjectBashGitInstructionsInMessages', () => {
  const originalEnv = process.env.CLAUDIN_BASH_GIT_IN_MESSAGES

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    } else {
      process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = originalEnv
    }
  })

  it('returns true by default (env unset)', () => {
    delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    expect(shouldInjectBashGitInstructionsInMessages()).toBe(true)
  })

  it('returns false when env is explicitly falsy', () => {
    for (const v of ['false', '0', 'no', 'off']) {
      process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = v
      expect(shouldInjectBashGitInstructionsInMessages()).toBe(false)
    }
  })

  it('returns true when env is truthy or any other string', () => {
    for (const v of ['true', '1', 'yes', 'on', 'whatever']) {
      process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = v
      expect(shouldInjectBashGitInstructionsInMessages()).toBe(true)
    }
  })
})

// `isLeanGitInstructionsEnabled()` is latched once per module instance — the
// body is cached prefix and must not change while the process lives — so each
// variant is rendered by a FRESH instance with the flag pinned for that first
// read. Neither variant then depends on what this process's shared instance
// happened to latch, a `CLAUDIN_LEAN_GIT_INSTRUCTIONS=1 bun test` included.
function importFreshPromptModule(): Promise<
  typeof import('src/tools/BashTool/prompt.js')
> {
  return import(`./prompt.js?ts=${Date.now()}-${Math.random()}`)
}

const BODY_ENV = [
  'CLAUDIN_LEAN_GIT_INSTRUCTIONS',
  'USER_TYPE',
  'ANTHROPIC_API_KEY',
] as const

// Every rule of the commit/PR protocol, each pattern phrased so that BOTH
// bodies must satisfy it: the lean one cut the reasoning between the rules,
// never a rule. A pattern only one wording can meet stops guarding the other.
const GIT_PROTOCOL_RULES: ReadonlyArray<{
  rule: string
  says: ReadonlyArray<string | RegExp>
}> = [
  {
    rule: 'commit only when the user asks, and ask when that is unclear',
    says: [
      /(?:Only create commits|Commit only) when the user asks/,
      /if (?:that is )?unclear, ask first/,
    ],
  },
  { rule: 'never update the git config', says: ['Never update the git config'] },
  { rule: 'never push unless asked', says: [/never push unless (?:you were )?asked/] },
  {
    rule: 'destructive commands and hook skips only when asked for by name',
    says: [
      '`push --force`',
      '`reset --hard`',
      '`checkout .`',
      '`restore .`',
      '`clean -f`',
      '`branch -D`',
      '`--no-verify`',
      '`--no-gpg-sign`',
      /asks? for them by name/,
    ],
  },
  {
    rule: 'a force push to main/master gets a warning, not a run',
    says: [
      /warn\w*[^.;]*force[- ]push\w*[^.;]*main\/master|force[- ]push[^.;]*main\/master[^.;]*warning/,
    ],
  },
  {
    rule: 'never amend: a failed pre-commit hook means a NEW commit',
    says: [
      'Never amend unless',
      'pre-commit hook',
      'the commit did NOT happen',
      /re-stage,? and (?:create|make) a NEW commit/,
    ],
  },
  {
    rule: 'read in one Git call, then stage + commit + status in one more',
    says: [
      `SINGLE ${GIT_TOOL_NAME} call`,
      '`git status` (never `-uall`',
      '`git diff`',
      '`git log`',
      /(?:Don't run anything|Run nothing) beyond/,
      `one more ${GIT_TOOL_NAME} call`,
      /nothing to commit[^.]*empty/i,
    ],
  },
  {
    rule: 'stage by name, never `git add -A` or `git add .`',
    says: [
      /[Ss]tage (?:the )?files \**by name/,
      '`git add -A`',
      '`git add .`',
      /likely holds? secrets/,
    ],
  },
  {
    rule: 'the whole message in ONE quoted -m argument, quoted by content',
    says: [
      'ONE quoted `-m` argument',
      /'…'[^.;]*backtick or a `\$`/,
      new RegExp(`no commit message needs ${BASH_TOOL_NAME}`, 'i'),
    ],
  },
  {
    rule: 'no `-i`, and no `--no-edit` with rebase',
    says: ['Never use `-i`', '`--no-edit` with `git rebase`'],
  },
  {
    rule: 'pull requests: gh via the Git tool, read the whole branch, open, return the URL',
    says: [
      '# Creating pull requests',
      `through the ${GIT_TOOL_NAME} tool`,
      'GitHub URL',
      '`gh api repos/foo/bar/pulls/123/comments`',
      'read the whole branch',
      /tracks a remote|remote tracking/,
      '`git diff [base-branch]...HEAD`',
      'push with `-u`',
      'title under 70 characters',
      /return(?:ing)? its URL/,
      /quote (?:it|the body) with '…'/i,
      'backslash-escape each backtick, `$`, `"` and `\\`',
    ],
  },
]

describe('getBashGitInstructionsBody', () => {
  const bodies = { full: '', lean: '', unset: '' }
  let attribution: ReturnType<typeof getAttributionTexts> = { commit: '', pr: '' }

  beforeAll(async () => {
    const saved = BODY_ENV.map(key => [key, process.env[key]] as const)
    delete process.env.USER_TYPE
    // getAttributionTexts() routes through model selection which demands an
    // API key. Non-key-shaped value avoids tripping secret-scanners on this file.
    if (!process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
    }
    try {
      // Sequential on purpose: the flag has to hold across each await.
      process.env.CLAUDIN_LEAN_GIT_INSTRUCTIONS = '0'
      bodies.full = (await importFreshPromptModule()).getBashGitInstructionsBody()
      process.env.CLAUDIN_LEAN_GIT_INSTRUCTIONS = '1'
      bodies.lean = (await importFreshPromptModule()).getBashGitInstructionsBody()
      delete process.env.CLAUDIN_LEAN_GIT_INSTRUCTIONS
      bodies.unset = (await importFreshPromptModule()).getBashGitInstructionsBody()
      attribution = getAttributionTexts()
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  it('CLAUDIN_LEAN_GIT_INSTRUCTIONS=0 restores the full, longer body', () => {
    // Without this every lean case below could pass on the full text: a
    // render that missed the flag looks exactly like a lean body that kept
    // every rule.
    expect(bodies.lean).not.toBe(bodies.full)
    expect(bodies.lean.length).toBeLessThan(bodies.full.length * 0.7)
  })

  it('the lean body is the default', () => {
    expect(bodies.unset).toBe(bodies.lean)
  })

  for (const variant of ['full', 'lean'] as const) {
    describe(variant, () => {
      const body = () => bodies[variant]

      it('returns a non-empty string for external (non-ant) users with full git+PR protocol', () => {
        expect(body().length).toBeGreaterThan(1000)
        expect(body()).toContain('# Committing changes with git')
        expect(body()).toContain('# Creating pull requests')
      })

      for (const { rule, says } of GIT_PROTOCOL_RULES) {
        it(`keeps the rule: ${rule}`, () => {
          const missing = says
            .filter(p =>
              typeof p === 'string' ? !body().includes(p) : !p.test(body()),
            )
            .map(String)
          expect({ rule, missing }).toEqual({ rule, missing: [] })
        })
      }

      it('keeps the rule: no AI attribution trailer or footer', () => {
        // Rendered only when the user configured no attribution of their own
        // (settings.attribution); with one, the body carries that text instead.
        if (attribution.commit) {
          expect(body()).toContain(attribution.commit)
        } else {
          expect(body()).toMatch(
            /(?:Do not append an|Add no) AI attribution trailer/,
          )
          expect(body()).toContain('Co-Authored-By: Claude')
        }
        if (attribution.pr) {
          expect(body()).toContain(attribution.pr)
        } else {
          expect(body()).toMatch(/(?:do not append an|Add no) AI footer/)
        }
      })

      it('warns about both `-i` (interactive) and `--no-edit` rebase flags', () => {
        // Regression guard: a prior trim merged two rebase-flag bullets into one
        // and accidentally dropped the `--no-edit` warning. The model would then
        // suggest `git rebase --no-edit` (not a valid rebase flag) and silently
        // swallow errors. Both warnings must stay in the body.
        expect(body()).toContain('-i')
        expect(body()).toContain('--no-edit')
      })

      it('shows a multi-line commit message the model can pass in one argument', () => {
        // The HEREDOC used to be the only path to a multi-line message; the Git
        // tool takes one now, and a "trim verbose examples" pass must not drop the
        // blank line that separates subject from body.
        expect(body()).toContain('git commit -m')
        expect(body()).toContain('\\n\\nBody line here.')
      })

      it('points the repository reads at the Git tool, batched', () => {
        // The protocol used to order three parallel Bash calls for status/diff/log.
        // With the Bash→Git redirect in place that text would fight the tool: the
        // model would be told to do the exact thing Bash now refuses.
        expect(body()).toContain(`SINGLE ${GIT_TOOL_NAME} call`)
        expect(body()).not.toContain(
          `Run the following bash commands in parallel, each using the ${BASH_TOOL_NAME} tool`,
        )
      })

      it('every example command in the protocol is one the Git tool accepts', () => {
        // The protocol now routes the commit and the PR through the Git tool, so a
        // prompt example the grammar refuses would leave those steps unreachable —
        // which is exactly what the `$(cat <<'EOF'` HEREDOC example would do.
        const examples = [...body().matchAll(/\{commands: (\[[\s\S]*?\])\}\)/g)]
        expect(examples.length).toBe(2)

        for (const [, json] of examples) {
          for (const command of JSON.parse(json as string) as string[]) {
            const parsed = parseGitCommand(command)
            expect(parsed.ok ? '' : `${command} → ${parsed.reason}`).toBe('')
          }
        }
      })

      it('no longer sends the commit or the PR body through Bash', () => {
        expect(body()).not.toContain(`git commit -m "$(cat <<'EOF'`)
        expect(body()).not.toContain(
          `needs a shell — send that one through the ${BASH_TOOL_NAME} tool`,
        )
        // A message holding a backtick AND an apostrophe used to be routed to a
        // HEREDOC because neither quote character could express it. Backslash
        // escaping inside "…" can, so the protocol must teach that instead of
        // naming an exception — otherwise the model reaches for Bash again.
        expect(body()).not.toContain('HEREDOC')
        expect(body()).toContain('backslash')
      })

      it('names every character that has to be escaped inside "…"', () => {
        // Dropping one of these from the bullet is silent: the message is accepted
        // and reaches git mangled. `\` is the one that looks droppable and is not —
        // a body describing a `\`-continuation ends the escape the model added for
        // the backtick right after it. Checked within the sentence itself: the
        // line around it names a backtick and `$` already, for the quote choice.
        const at = body().indexOf('put a backslash before')
        expect(at).toBeGreaterThan(-1)
        const sentence = body().slice(at, body().indexOf('.', at))
        for (const char of ['`"`', '`\\`', 'backtick', '`$`']) {
          expect(sentence).toContain(char)
        }
      })

      it('names every destructive command the model must not run unasked', () => {
        // The trim that took this block from 7.4 KB to ~2.8 KB kept the deny list
        // verbatim on purpose: it is the one part of the protocol where fewer
        // tokens buy a worse outcome. A later pass that compresses the list into
        // an adjective ("destructive git commands") drops the names, and the model
        // is left guessing which ones those are.
        for (const command of [
          'push --force',
          'reset --hard',
          'checkout .',
          'restore .',
          'clean -f',
          'branch -D',
          '--no-verify',
          '--no-gpg-sign',
          'git add -A',
          'git add .',
        ]) {
          expect(body()).toContain(command)
        }
      })

      it('asks for one batched call, not for parallel commands', () => {
        // The opener used to say "(run independent commands in parallel where
        // possible)" two lines above "in a SINGLE Git call" — both instructions on
        // the same screen, and only one of them is what the Git tool wants. The
        // Bash→Git redirect refuses the parallel reading outright.
        expect(body()).toContain(`SINGLE ${GIT_TOOL_NAME} call`)
        expect(body()).not.toContain('in parallel where possible')
      })
    })
  }
})

describe('BashTool description vs git block injection', () => {
  const originalEnv = process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
  const originalDisable = process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS
  const originalUserType = process.env.USER_TYPE
  const originalApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    // Force git instructions ON via env to avoid relying on settings.json.
    process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = 'false'
    delete process.env.USER_TYPE
    if (!process.env.ANTHROPIC_API_KEY) {
      // Non-key-shaped value avoids tripping secret-scanners on this file.
      process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
    }
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    } else {
      process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = originalEnv
    }
    if (originalDisable === undefined) {
      delete process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS
    } else {
      process.env.CLAUDIN_DISABLE_GIT_INSTRUCTIONS = originalDisable
    }
    if (originalUserType === undefined) {
      delete process.env.USER_TYPE
    } else {
      process.env.USER_TYPE = originalUserType
    }
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey
    }
  })

  it('omits git block from description when injection is enabled (default)', () => {
    delete process.env.CLAUDIN_BASH_GIT_IN_MESSAGES
    const prompt = getSimplePrompt()
    expect(prompt).not.toContain('# Committing changes with git')
    expect(prompt).not.toContain('# Creating pull requests')
  })

  it('keeps git block inline in description when injection is disabled', () => {
    process.env.CLAUDIN_BASH_GIT_IN_MESSAGES = 'false'
    const prompt = getSimplePrompt()
    expect(prompt).toContain('# Committing changes with git')
    expect(prompt).toContain('# Creating pull requests')
  })
})
