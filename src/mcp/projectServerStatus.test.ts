import { describe, expect, test } from 'bun:test'
import {
  decideProjectServerStatus,
  type ProjectServerApprovalInputs,
  type ProjectServerStatus,
} from 'src/mcp/projectServerStatus.js'

const NOTHING: ProjectServerApprovalInputs = {
  enabledNames: [],
  disabledNames: [],
  enableAll: false,
  bypassAcceptedOutsideProject: false,
  interactive: true,
  projectSettingsEnabled: true,
}

describe('decideProjectServerStatus', () => {
  const cases: Array<[label: string, change: Partial<ProjectServerApprovalInputs>, out: ProjectServerStatus]> = [
    ['nothing applies', {}, 'pending'],
    ['listed as enabled', { enabledNames: ['srv'] }, 'approved'],
    ['enabled under a name that folds differently', { enabledNames: ['s.rv'] }, 'pending'],
    ['enable-all', { enableAll: true }, 'approved'],
    ['disabled beats enabled', { enabledNames: ['srv'], disabledNames: ['srv'] }, 'rejected'],
    ['disabled beats enable-all', { enableAll: true, disabledNames: ['srv'] }, 'rejected'],
    ['disabled beats bypass', { bypassAcceptedOutsideProject: true, disabledNames: ['srv'] }, 'rejected'],
    ['disabled beats non-interactive', { interactive: false, disabledNames: ['srv'] }, 'rejected'],
    ['listed as disabled', { disabledNames: ['srv'] }, 'rejected'],
    ['bypass accepted', { bypassAcceptedOutsideProject: true }, 'approved'],
    ['bypass accepted, project settings off', { bypassAcceptedOutsideProject: true, projectSettingsEnabled: false }, 'pending'],
    ['non-interactive', { interactive: false }, 'approved'],
    ['non-interactive, project settings off', { interactive: false, projectSettingsEnabled: false }, 'pending'],
    ['listed as enabled, project settings off', { enabledNames: ['srv'], projectSettingsEnabled: false }, 'approved'],
  ]
  test.each(cases)('%s → %p', (_label, change, out) => {
    expect(decideProjectServerStatus('srv', { ...NOTHING, ...change })).toBe(out)
  })

  test('both sides are folded before comparing', () => {
    expect(decideProjectServerStatus('my server', { ...NOTHING, enabledNames: ['my.server'] })).toBe('approved')
    expect(decideProjectServerStatus('my/server', { ...NOTHING, disabledNames: ['my_server'] })).toBe('rejected')
  })
})
