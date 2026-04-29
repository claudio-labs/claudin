// Tests for BashTool prompt assembly: the git-instructions toggle, the
// extracted body builder, and the simple-prompt rendering.
//
// Note on `ANTHROPIC_API_KEY` stubbing in the body tests: `getBashGitInstructionsBody()`
// calls `getAttributionTexts()` (src/utils/attribution.ts), which routes
// through model resolution and demands an API key even for these
// read-only string assertions. The stub is load-bearing — without it the
// tests blow up at import-resolution time.
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  getBashGitInstructionsBody,
  getSimplePrompt,
  shouldInjectBashGitInstructionsInMessages,
} from './prompt.js'

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

  it('returns a non-empty string for ant users (short variant)', () => {
    process.env.USER_TYPE = 'ant'
    const body = getBashGitInstructionsBody()
    expect(body.length).toBeGreaterThan(0)
    expect(body).toContain('# Git operations')
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
