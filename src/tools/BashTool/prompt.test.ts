// Tests for BashTool prompt assembly: the git-instructions toggle, the
// extracted body builder, and the simple-prompt rendering.
//
// Note on `ANTHROPIC_API_KEY` stubbing in the body tests: `getBashGitInstructionsBody()`
// calls `getAttributionTexts()` (src/utils/attribution.ts), which routes
// through model resolution and demands an API key even for these
// read-only string assertions. The stub is load-bearing — without it the
// tests blow up at import-resolution time.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { parseGitCommand } from 'src/tools/GitTool/grammar.js'
import { GIT_TOOL_NAME } from 'src/tools/GitTool/prompt.js'
import {
  getBashGitInstructionsBody,
  getSimplePrompt,
  shouldInjectBashGitInstructionsInMessages,
} from './prompt.js'
import { BASH_TOOL_NAME } from './toolName.js'

describe('shouldInjectBashGitInstructionsInMessages', () => {
  const originalEnv = process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = originalEnv
    }
  })

  it('returns true by default (env unset)', () => {
    delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    expect(shouldInjectBashGitInstructionsInMessages()).toBe(true)
  })

  it('returns false when env is explicitly falsy', () => {
    for (const v of ['false', '0', 'no', 'off']) {
      process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = v
      expect(shouldInjectBashGitInstructionsInMessages()).toBe(false)
    }
  })

  it('returns true when env is truthy or any other string', () => {
    for (const v of ['true', '1', 'yes', 'on', 'whatever']) {
      process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = v
      expect(shouldInjectBashGitInstructionsInMessages()).toBe(true)
    }
  })
})

describe('getBashGitInstructionsBody', () => {
  const originalUserType = process.env.USER_TYPE
  const originalApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    // getAttributionTexts() routes through model selection which demands an
    // API key. Provide a stub for these read-only string-shape tests.
    if (!process.env.ANTHROPIC_API_KEY) {
      // Non-key-shaped value avoids tripping secret-scanners on this file.
      process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
    }
  })

  afterEach(() => {
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

  it('returns a non-empty string for external (non-ant) users with full git+PR protocol', () => {
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()
    expect(body.length).toBeGreaterThan(1000)
    expect(body).toContain('# Committing changes with git')
    expect(body).toContain('# Creating pull requests')
  })

  it('warns about both `-i` (interactive) and `--no-edit` rebase flags', () => {
    // Regression guard: a prior trim merged two rebase-flag bullets into one
    // and accidentally dropped the `--no-edit` warning. The model would then
    // suggest `git rebase --no-edit` (not a valid rebase flag) and silently
    // swallow errors. Both warnings must stay in the body.
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()
    expect(body).toContain('-i')
    expect(body).toContain('--no-edit')
  })

  it('shows a multi-line commit message the model can pass in one argument', () => {
    // The HEREDOC used to be the only path to a multi-line message; the Git
    // tool takes one now, and a "trim verbose examples" pass must not drop the
    // blank line that separates subject from body.
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()
    expect(body).toContain('git commit -m')
    expect(body).toContain('\\n\\nBody line here.')
  })

  it('points the repository reads at the Git tool, batched', () => {
    // The protocol used to order three parallel Bash calls for status/diff/log.
    // With the Bash→Git redirect in place that text would fight the tool: the
    // model would be told to do the exact thing Bash now refuses.
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()
    expect(body).toContain(`SINGLE ${GIT_TOOL_NAME} call`)
    expect(body).not.toContain(
      `Run the following bash commands in parallel, each using the ${BASH_TOOL_NAME} tool`,
    )
  })

  it('every example command in the protocol is one the Git tool accepts', () => {
    // The protocol now routes the commit and the PR through the Git tool, so a
    // prompt example the grammar refuses would leave those steps unreachable —
    // which is exactly what the `$(cat <<'EOF'` HEREDOC example would do.
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()

    const examples = [...body.matchAll(/\{commands: (\[[\s\S]*?\])\}\)/g)]
    expect(examples.length).toBe(2)

    for (const [, json] of examples) {
      for (const command of JSON.parse(json as string) as string[]) {
        const parsed = parseGitCommand(command)
        expect(parsed.ok ? '' : `${command} → ${parsed.reason}`).toBe('')
      }
    }
  })

  it('no longer sends the commit or the PR body through Bash', () => {
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()
    expect(body).not.toContain(`git commit -m "$(cat <<'EOF'`)
    expect(body).not.toContain(`needs a shell — send that one through the ${BASH_TOOL_NAME} tool`)
    // A message holding a backtick AND an apostrophe used to be routed to a
    // HEREDOC because neither quote character could express it. Backslash
    // escaping inside "…" can, so the protocol must teach that instead of
    // naming an exception — otherwise the model reaches for Bash again.
    expect(body).not.toContain('HEREDOC')
    expect(body).toContain('backslash')
  })

  it('names every character that has to be escaped inside "…"', () => {
    // Dropping one of these from the bullet is silent: the message is accepted
    // and reaches git mangled. `\` is the one that looks droppable and is not —
    // a body describing a `\`-continuation ends the escape the model added for
    // the backtick right after it.
    delete process.env.USER_TYPE
    const body = getBashGitInstructionsBody()
    const bullet = body
      .split('\n')
      .find(line => line.includes('put a backslash before'))
    expect(bullet).toBeDefined()
    for (const char of ['`"`', '`\\`', 'backtick', '`$`']) {
      expect(bullet).toContain(char)
    }
  })
})

describe('BashTool description vs git block injection', () => {
  const originalEnv = process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
  const originalDisable = process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
  const originalUserType = process.env.USER_TYPE
  const originalApiKey = process.env.ANTHROPIC_API_KEY

  beforeEach(() => {
    // Force git instructions ON via env to avoid relying on settings.json.
    process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = 'false'
    delete process.env.USER_TYPE
    if (!process.env.ANTHROPIC_API_KEY) {
      // Non-key-shaped value avoids tripping secret-scanners on this file.
      process.env.ANTHROPIC_API_KEY = 'test-stub-no-network'
    }
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    } else {
      process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = originalEnv
    }
    if (originalDisable === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS
    } else {
      process.env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS = originalDisable
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
    delete process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES
    const prompt = getSimplePrompt()
    expect(prompt).not.toContain('# Committing changes with git')
    expect(prompt).not.toContain('# Creating pull requests')
  })

  it('keeps git block inline in description when injection is disabled', () => {
    process.env.CLAUDE_CODE_BASH_GIT_IN_MESSAGES = 'false'
    const prompt = getSimplePrompt()
    expect(prompt).toContain('# Committing changes with git')
    expect(prompt).toContain('# Creating pull requests')
  })
})
