import { expect, test } from 'bun:test'

import {
  type Fable5SettingsPatch,
  rewriteFable5InProjects,
  rewriteFable5InSettings,
} from 'src/platform/migrations/migrateFable5ToFable51.js'
import type { ProjectConfig } from 'src/platform/config/config.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

// These cover the pure half of the migration. It is split that way on purpose:
// the shell reads getSettingsForSource / getGlobalConfig, both of which other
// files mock.module, and Bun applies those overrides process-wide for the whole
// run. Asserting on the rewrite itself needs no mocking at all.

// Accepts a patch as well as a settings literal, so the idempotence test can
// feed a rewrite's own output straight back in.
const settings = (
  s: Partial<SettingsJson> | Fable5SettingsPatch,
): SettingsJson => s as SettingsJson

const project = (p: Partial<ProjectConfig>): ProjectConfig =>
  ({ allowedTools: [], mcpContextUris: [], ...p }) as ProjectConfig

test('rewrites settings.model', () => {
  expect(rewriteFable5InSettings(settings({ model: 'claude-fable-5' }))).toEqual(
    { model: 'claude-fable-5-1' },
  )
})

test('rewrites the Bedrock-prefixed form', () => {
  expect(
    rewriteFable5InSettings(settings({ model: 'anthropic.claude-fable-5' })),
  ).toEqual({ model: 'anthropic.claude-fable-5-1' })
})

test('rewrites advisorModel', () => {
  expect(
    rewriteFable5InSettings(settings({ advisorModel: 'claude-fable-5' })),
  ).toEqual({ advisorModel: 'claude-fable-5-1' })
})

test('rewrites only the retired entries of availableModels', () => {
  expect(
    rewriteFable5InSettings(
      settings({
        availableModels: ['opus', 'claude-fable-5', 'claude-sonnet-5'],
      }),
    ),
  ).toEqual({
    availableModels: ['opus', 'claude-fable-5-1', 'claude-sonnet-5'],
  })
})

test('rewrites modelOverrides on the KEY side, preserving the value', () => {
  // The values are provider-specific strings (typically Bedrock inference
  // profile ARNs) and must survive untouched — only the canonical key moves.
  expect(
    rewriteFable5InSettings(
      settings({
        modelOverrides: {
          'claude-fable-5': 'arn:aws:bedrock:us-east-1::fable-profile',
          'claude-opus-5': 'arn:aws:bedrock:us-east-1::opus-profile',
        },
      }),
    ),
  ).toEqual({
    modelOverrides: {
      'claude-fable-5-1': 'arn:aws:bedrock:us-east-1::fable-profile',
      'claude-opus-5': 'arn:aws:bedrock:us-east-1::opus-profile',
    },
  })
})

test('tombstones the retired modelOverrides key so the deep merge drops it', () => {
  // updateSettingsForSource merges plain objects (mergeWith, settings.ts:478):
  // arrays are replaced but a record is fused, so emitting only the renamed key
  // leaves the retired one alive beside it on disk. Its customizer reads an
  // undefined value as "delete this key", which is the only lever available.
  //
  // Asserted through Object.keys rather than toEqual on purpose: toEqual
  // ignores properties whose value is undefined, so it passes with the
  // tombstone deleted — a green test guarding nothing. Verified end-to-end
  // against a seeded CLAUDIN_CONFIG_DIR before this test was written.
  const patch = rewriteFable5InSettings(
    settings({ modelOverrides: { 'claude-fable-5': 'arn:x' } }),
  )
  const overrides = patch?.modelOverrides ?? {}
  expect(Object.keys(overrides).sort()).toEqual([
    'claude-fable-5',
    'claude-fable-5-1',
  ])
  expect(overrides['claude-fable-5']).toBeUndefined()
  expect(overrides['claude-fable-5-1']).toBe('arn:x')
})

test('rewrites every field at once', () => {
  const patch = rewriteFable5InSettings(
    settings({
      model: 'claude-fable-5',
      advisorModel: 'claude-fable-5',
      availableModels: ['claude-fable-5'],
      modelOverrides: { 'claude-fable-5': 'arn:x' },
    }),
  )
  expect(patch).toEqual({
    model: 'claude-fable-5-1',
    advisorModel: 'claude-fable-5-1',
    availableModels: ['claude-fable-5-1'],
    modelOverrides: { 'claude-fable-5-1': 'arn:x' },
  })
})

test('returns null when nothing references Fable 5', () => {
  expect(rewriteFable5InSettings(settings({ model: 'claude-opus-5' }))).toBeNull()
  expect(rewriteFable5InSettings(settings({}))).toBeNull()
  expect(rewriteFable5InSettings(null)).toBeNull()
})

test('is idempotent — a second pass is a no-op, not fable-5-1-1', () => {
  // runMigrations' version gate is `!==`, so every version bump re-runs the
  // whole set for every user. A prefix or substring match here would keep
  // appending on each pass.
  const first = rewriteFable5InSettings(settings({ model: 'claude-fable-5' }))
  expect(first).toEqual({ model: 'claude-fable-5-1' })
  expect(rewriteFable5InSettings(settings(first!))).toBeNull()
  expect(
    rewriteFable5InSettings(settings({ model: 'claude-fable-5-1' })),
  ).toBeNull()
})

test('does not touch a model that merely starts with the retired id', () => {
  expect(
    rewriteFable5InSettings(settings({ model: 'claude-fable-5-turbo' })),
  ).toBeNull()
})

test('rewrites activeModelForProject, leaving other projects alone', () => {
  const projects = {
    '/repo/a': project({ activeModelForProject: 'claude-fable-5' }),
    '/repo/b': project({ activeModelForProject: 'claude-opus-5' }),
    '/repo/c': project({}),
  }
  const out = rewriteFable5InProjects(projects)
  expect(out?.['/repo/a']?.activeModelForProject).toBe('claude-fable-5-1')
  expect(out?.['/repo/b']?.activeModelForProject).toBe('claude-opus-5')
  expect(out?.['/repo/c']?.activeModelForProject).toBeUndefined()
})

test('preserves the rest of a rewritten project entry', () => {
  const out = rewriteFable5InProjects({
    '/repo/a': project({
      activeModelForProject: 'claude-fable-5',
      activeModelForProjectProfileId: 'profile-1',
      allowedTools: ['Bash'],
    }),
  })
  expect(out?.['/repo/a']?.activeModelForProjectProfileId).toBe('profile-1')
  expect(out?.['/repo/a']?.allowedTools).toEqual(['Bash'])
})

test('returns null for projects with no Fable 5 pin', () => {
  expect(rewriteFable5InProjects(undefined)).toBeNull()
  expect(rewriteFable5InProjects({})).toBeNull()
  expect(
    rewriteFable5InProjects({
      '/repo/a': project({ activeModelForProject: 'claude-fable-5-1' }),
    }),
  ).toBeNull()
})
