import { expect, test } from 'bun:test'

import {
  rewriteFable51InProjects,
  rewriteFable51Pin,
} from 'src/platform/migrations/migrateFable51ToFableAlias.js'
import { rewriteFable5InSettings } from 'src/platform/migrations/migrateFable5ToFable51.js'
import type { ProjectConfig } from 'src/platform/config/config.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

// The pure half only, like migrateFable5ToFable51.test.ts: the shell reads
// getSettingsForSource / getGlobalConfig, which other files mock.module for the
// whole run.

const project = (p: Partial<ProjectConfig>): ProjectConfig =>
  ({ allowedTools: [], mcpContextUris: [], ...p }) as ProjectConfig

const firstPartyOnly = (profileId: string | undefined) => profileId === undefined || profileId === 'anthropic'

test('moves a Fable 5.1 pin to the fable alias, as Claude Code 2.1.322 does', () => {
  expect(rewriteFable51Pin('claude-fable-5-1')).toBe('fable')
})

test('drops the [1m] tag: Fable is 1M native and the alias would drop it anyway', () => {
  expect(rewriteFable51Pin('claude-fable-5-1[1m]')).toBe('fable')
})

test('leaves every other model alone', () => {
  for (const model of [
    undefined,
    'fable',
    'fable51',
    'claude-fable-5-2',
    'claude-fable-5',
    'claude-fable-5-1-turbo',
    // The Bedrock id is never first party; the migration does not reach it.
    'anthropic.claude-fable-5-1',
    'claude-opus-5-5',
  ]) {
    expect(rewriteFable51Pin(model)).toBeUndefined()
  }
})

test('a second pass is a no-op', () => {
  expect(rewriteFable51Pin(rewriteFable51Pin('claude-fable-5-1'))).toBeUndefined()
})

// migrateFable5ToFable51 runs first in runMigrations, so a Fable 5 pin from
// before 2026-09-01 lands on 5.1 and then here, in one startup.
test('a Fable 5 pin reaches the alias through the Fable 5.1 migration', () => {
  const settings = { model: 'claude-fable-5' } as SettingsJson
  const onFable51 = rewriteFable5InSettings(settings)?.model as string | undefined
  expect(onFable51).toBe('claude-fable-5-1')
  expect(rewriteFable51Pin(onFable51)).toBe('fable')
})

test('rewrites the project pins that belong to a first-party profile', () => {
  const out = rewriteFable51InProjects(
    {
      '/repo/no-profile': project({ activeModelForProject: 'claude-fable-5-1' }),
      '/repo/anthropic': project({
        activeModelForProject: 'claude-fable-5-1[1m]',
        activeModelForProjectProfileId: 'anthropic',
      }),
      '/repo/vertex': project({
        activeModelForProject: 'claude-fable-5-1',
        activeModelForProjectProfileId: 'vertex',
      }),
      '/repo/opus': project({ activeModelForProject: 'claude-opus-5-5' }),
      '/repo/none': project({}),
    },
    firstPartyOnly,
  )
  expect(out?.['/repo/no-profile']?.activeModelForProject).toBe('fable')
  expect(out?.['/repo/anthropic']?.activeModelForProject).toBe('fable')
  // On Vertex the alias would resolve to a model the project may not have.
  expect(out?.['/repo/vertex']?.activeModelForProject).toBe('claude-fable-5-1')
  expect(out?.['/repo/opus']?.activeModelForProject).toBe('claude-opus-5-5')
  expect(out?.['/repo/none']?.activeModelForProject).toBeUndefined()
})

test('keeps the rest of a rewritten project entry, profile id included', () => {
  const out = rewriteFable51InProjects(
    {
      '/repo/a': project({
        activeModelForProject: 'claude-fable-5-1',
        activeModelForProjectProfileId: 'anthropic',
        allowedTools: ['Bash'],
      }),
    },
    firstPartyOnly,
  )
  expect(out?.['/repo/a']?.activeModelForProjectProfileId).toBe('anthropic')
  expect(out?.['/repo/a']?.allowedTools).toEqual(['Bash'])
})

test('returns null when no first-party project pins Fable 5.1', () => {
  expect(rewriteFable51InProjects(undefined, firstPartyOnly)).toBeNull()
  expect(rewriteFable51InProjects({}, firstPartyOnly)).toBeNull()
  expect(
    rewriteFable51InProjects(
      {
        '/repo/a': project({ activeModelForProject: 'fable' }),
        '/repo/b': project({ activeModelForProject: 'claude-fable-5-1', activeModelForProjectProfileId: 'vertex' }),
      },
      firstPartyOnly,
    ),
  ).toBeNull()
})
