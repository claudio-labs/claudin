import { describe, expect, test } from 'bun:test'

import {
  _buildWrittenGlobalConfig,
  DEFAULT_GLOBAL_CONFIG,
  type GlobalConfig,
  type ProjectConfig,
} from 'src/services/config/config.js'

// Regression guard for the projects clobber: saveGlobalConfig's production
// paths persist `_buildWrittenGlobalConfig(updaterResult)`. The original code
// rebuilt `projects` from the PRE-updater snapshot, which silently discarded
// any project edits made inside the updater — deleteProviderProfile's
// project-override cleanup (and the startup dangling-pointer heal) never
// persisted because of it.

function baseConfig(projects: Record<string, ProjectConfig>): GlobalConfig {
  return {
    ...DEFAULT_GLOBAL_CONFIG,
    projects,
  }
}

describe('_buildWrittenGlobalConfig', () => {
  test('preserves project edits made by the updater', () => {
    const updaterResult = baseConfig({
      '/proj/healed': {
        // Override stripped by the updater — only the sibling key remains.
        hasTrustDialogAccepted: true,
      } as ProjectConfig,
    })

    const written = _buildWrittenGlobalConfig(updaterResult)

    expect(written.projects?.['/proj/healed']).toEqual({
      hasTrustDialogAccepted: true,
    } as ProjectConfig)
  })

  test('strips legacy history from the updater result', () => {
    const updaterResult = baseConfig({
      '/proj/legacy': {
        activeProviderProfileId: 'profile_a',
        history: [{ display: 'old', pastedContents: {} }],
      } as unknown as ProjectConfig,
    })

    const written = _buildWrittenGlobalConfig(updaterResult)

    const project = written.projects?.['/proj/legacy'] as
      | (ProjectConfig & { history?: unknown })
      | undefined
    expect(project?.activeProviderProfileId).toBe('profile_a')
    expect(project?.history).toBeUndefined()
  })

  test('returns projects untouched (same reference) when no legacy history exists', () => {
    const projects = {
      '/proj/a': { activeProviderProfileId: 'profile_a' } as ProjectConfig,
    }
    const written = _buildWrittenGlobalConfig(baseConfig(projects))
    expect(written.projects).toBe(projects)
  })
})
