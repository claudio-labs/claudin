import { afterAll, afterEach, beforeEach, expect, mock, test } from 'bun:test'

// Spread into plain objects so the teardown restores the original bindings
// rather than the live ESM namespace (which mock.module mutates after the fact).
const realConfig = { ...(await import('src/services/config/config.js')) }
const realSettings = { ...(await import('src/services/settings/settings.js')) }

type MockProjectConfig = {
  activeEffortForProject?: string
}

let projectConfig: MockProjectConfig = {}
let globalEffort: string | undefined
let saveCount = 0
let saveThrows = false

function installMocks(): void {
  mock.module('src/services/config/config.js', () => ({
    ...realConfig,
    getCurrentProjectConfig: () => projectConfig,
    saveCurrentProjectConfig: (
      updater: (current: MockProjectConfig) => MockProjectConfig,
    ) => {
      saveCount++
      if (saveThrows) {
        throw new Error('disk is full')
      }
      projectConfig = updater(projectConfig)
    },
  }))
  mock.module('src/services/settings/settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => ({ effortLevel: globalEffort }),
    getSettingsForSource: (source: string) =>
      source === 'userSettings' ? { effortLevel: globalEffort } : null,
  }))
}

async function importFreshEffort() {
  installMocks()
  return import(`./effort.js?ts=${Date.now()}-${Math.random()}`)
}

beforeEach(() => {
  projectConfig = {}
  globalEffort = undefined
  saveCount = 0
  saveThrows = false
})

afterEach(() => {
  mock.module('src/services/config/config.js', () => realConfig)
  mock.module('src/services/settings/settings.js', () => realSettings)
})

afterAll(() => {
  realConfig.resetGlobalConfigForTests?.()
})

test('project pin wins over the global effortLevel', async () => {
  projectConfig = { activeEffortForProject: 'high' }
  globalEffort = 'low'

  const mod = await importFreshEffort()
  expect(mod.getInitialEffortSetting()).toBe('high')
  expect(mod.getProjectEffortOrigin()).toBe('project')
})

test('no pin inherits the global effortLevel', async () => {
  globalEffort = 'medium'

  const mod = await importFreshEffort()
  expect(mod.getInitialEffortSetting()).toBe('medium')
  expect(mod.getProjectEffortOrigin()).toBe('global')
})

test('no pin and no global resolves undefined (model default downstream)', async () => {
  const mod = await importFreshEffort()
  expect(mod.getInitialEffortSetting()).toBeUndefined()
  expect(mod.getProjectEffortOrigin()).toBe('none')
})

test("an 'auto' pin shadows a globally pinned level", async () => {
  // This is the whole point of the sentinel: without it, a project could never
  // opt out of a global effortLevel.
  projectConfig = { activeEffortForProject: 'auto' }
  globalEffort = 'high'

  const mod = await importFreshEffort()
  expect(mod.getInitialEffortSetting()).toBeUndefined()
  expect(mod.getProjectEffortOrigin()).toBe('project-auto')
})

test('an unknown pin (hand-edited config) is ignored, not leaked into the session', async () => {
  projectConfig = { activeEffortForProject: 'turbo' }
  globalEffort = 'low'

  const mod = await importFreshEffort()
  expect(mod.getProjectEffortPin()).toBeUndefined()
  expect(mod.getInitialEffortSetting()).toBe('low')
})

test('adaptive round-trips as a pin', async () => {
  const mod = await importFreshEffort()
  expect(mod.persistEffortForProject('adaptive').error).toBeUndefined()
  expect(projectConfig.activeEffortForProject).toBe('adaptive')
  expect(mod.getInitialEffortSetting()).toBe('adaptive')
})

test('persistEffortForProject writes the level to the project config', async () => {
  globalEffort = 'low'

  const mod = await importFreshEffort()
  expect(mod.persistEffortForProject('max').error).toBeUndefined()
  expect(projectConfig.activeEffortForProject).toBe('max')
  expect(mod.getInitialEffortSetting()).toBe('max')
})

test('a numeric effort stays session-only and never touches the config', async () => {
  const mod = await importFreshEffort()
  expect(mod.persistEffortForProject(30).error).toBeUndefined()
  expect(saveCount).toBe(0)
  expect(projectConfig.activeEffortForProject).toBeUndefined()
})

test('pinProjectEffortAuto writes the sentinel', async () => {
  const mod = await importFreshEffort()
  expect(mod.pinProjectEffortAuto().error).toBeUndefined()
  expect(projectConfig.activeEffortForProject).toBe('auto')
})

test('clearProjectEffortPin drops the pin and restores inheritance', async () => {
  projectConfig = { activeEffortForProject: 'high' }
  globalEffort = 'low'

  const mod = await importFreshEffort()
  expect(mod.clearProjectEffortPin().error).toBeUndefined()
  expect(projectConfig.activeEffortForProject).toBeUndefined()
  expect(mod.getInitialEffortSetting()).toBe('low')
  expect(mod.getProjectEffortOrigin()).toBe('global')
})

test('a failed write is returned as an error instead of throwing', async () => {
  saveThrows = true

  const mod = await importFreshEffort()
  const result = mod.persistEffortForProject('high')
  expect(result.error).toBeInstanceOf(Error)
  expect(result.error?.message).toContain('disk is full')
})

test('getPriorPersistedEffort prefers the pin, falls back to userSettings, and treats auto as no choice', async () => {
  // Backs resolvePickerEffortPersistence's "did the user ever choose?" check.
  globalEffort = 'medium'
  projectConfig = { activeEffortForProject: 'xhigh' }

  const mod = await importFreshEffort()
  expect(mod.getPriorPersistedEffort()).toBe('xhigh')

  projectConfig = {}
  expect(mod.getPriorPersistedEffort()).toBe('medium')

  projectConfig = { activeEffortForProject: 'auto' }
  expect(mod.getPriorPersistedEffort()).toBeUndefined()
})
