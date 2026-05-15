import { describe, expect, test } from 'bun:test'
import { buildAutofixPrompt } from './prompt.js'

describe('buildAutofixPrompt', () => {
  const baseInput = {
    prNumber: 42,
    branch: 'feature/x',
    defaultBranch: 'main',
    args: '',
  } as const

  test('dry-run mode without args matches snapshot', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'dry-run' })
    expect(prompt).toMatchSnapshot()
  })

  test('dry-run mode with extra user args appends them', () => {
    const prompt = buildAutofixPrompt({
      ...baseInput,
      mode: 'dry-run',
      args: 'focus on tests',
    })
    expect(prompt).toContain('Additional user input: focus on tests')
  })

  test('dry-run prompt references the resolved PR number and branch', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'dry-run' })
    expect(prompt).toContain('PR #42')
    expect(prompt).toContain('feature/x')
  })

  test('dry-run prompt is strictly read-only (no edit/commit/push verbs)', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'dry-run' })
    expect(prompt).toContain('Do NOT edit any files')
    expect(prompt).toContain('do NOT commit')
    expect(prompt).toContain('do NOT push')
  })

  test('dry-run prompt includes all triage labels', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'dry-run' })
    for (const label of [
      'ok',
      'change_request',
      'nit',
      'praise',
      'incorrect',
      'pr_questionable',
      'unclear',
      'out_of_scope',
    ]) {
      expect(prompt).toContain(`**${label}**`)
    }
  })

  test('default mode prompt matches snapshot', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toMatchSnapshot()
  })

  test('default mode prompts AskUserQuestion for unclear/pr_questionable', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('AskUserQuestion')
    expect(prompt).toContain('pr_questionable')
    expect(prompt).toContain('unclear')
  })

  test('default mode forbids destructive git flags', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('--no-verify')
    expect(prompt).toContain('--amend')
    expect(prompt).toContain('push --force')
    expect(prompt).toContain('default branch')
  })

  test('default mode references reply endpoints for both comment types', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('/comments/{comment_id}/replies')
    expect(prompt).toContain('/issues/42/comments')
  })

  test('default mode warns about CHANGES_REQUESTED re-approval', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('CHANGES_REQUESTED')
    expect(prompt).toContain('re-approve')
  })

  test('default mode describes loop, anti-stall, and 5-iteration cap', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('5 iterations')
    expect(prompt).toContain('anti-stall')
    expect(prompt).toContain('(comment_id, updated_at)')
    expect(prompt).toContain('Do not sleep')
  })

  test('default mode performs PR-level sanity check before fixing', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('mergeStateStatus')
    expect(prompt).toContain('conflicting')
  })

  test('default mode dedups replies via viewer identity', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('gh api user')
  })

  test('default mode handles broken fix with soft reset', () => {
    const prompt = buildAutofixPrompt({ ...baseInput, mode: 'default' })
    expect(prompt).toContain('git reset --soft')
  })
})
