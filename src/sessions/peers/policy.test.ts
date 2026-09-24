import { describe, expect, test } from 'bun:test'

import {
  decideInbound,
  type InboundSetting,
  permissionClassOf,
  resolveInboundSetting,
} from 'src/sessions/peers/policy.js'

describe('decideInbound', () => {
  test('with no setting, matching permission classes deliver and mismatches hold', () => {
    expect(decideInbound({ setting: undefined, sender: 'prompting', receiver: 'prompting' })).toEqual({ action: 'deliver' })
    expect(decideInbound({ setting: undefined, sender: 'bypass', receiver: 'bypass' })).toEqual({ action: 'deliver' })
    expect(decideInbound({ setting: undefined, sender: 'bypass', receiver: 'prompting' })).toMatchObject({
      action: 'hold',
      reason: 'the sender runs with permissions bypassed and this session does not',
    })
    expect(decideInbound({ setting: undefined, sender: 'prompting', receiver: 'bypass' })).toMatchObject({
      action: 'hold',
      reason: 'this session runs with permissions bypassed and the sender does not',
    })
  })

  test('a sender that states no mode is held only by a bypass receiver', () => {
    expect(decideInbound({ setting: undefined, sender: undefined, receiver: 'prompting' })).toEqual({ action: 'deliver' })
    expect(decideInbound({ setting: undefined, sender: undefined, receiver: 'bypass' }).action).toBe('hold')
  })

  test('an explicit setting overrides parity either way', () => {
    expect(decideInbound({ setting: 'accept', sender: 'bypass', receiver: 'prompting' })).toEqual({ action: 'deliver' })
    expect(decideInbound({ setting: 'hold', sender: 'prompting', receiver: 'prompting' }).action).toBe('hold')
    expect(decideInbound({ setting: 'refuse', sender: 'prompting', receiver: 'prompting' }).action).toBe('refuse')
  })
})

describe('resolveInboundSetting', () => {
  const reader =
    (values: Partial<Record<string, InboundSetting>>) =>
    (source: string): InboundSetting | undefined =>
      values[source]

  test('policy beats a flag beats the user', () => {
    expect(resolveInboundSetting(reader({ userSettings: 'accept', flagSettings: 'hold' }))).toBe('hold')
    expect(resolveInboundSetting(reader({ userSettings: 'refuse', policySettings: 'accept' }))).toBe('accept')
  })

  test('a repository can only make a session stricter', () => {
    expect(resolveInboundSetting(reader({ projectSettings: 'accept' }))).toBeUndefined()
    expect(resolveInboundSetting(reader({ userSettings: 'hold', localSettings: 'accept' }))).toBe('hold')
    expect(resolveInboundSetting(reader({ userSettings: 'accept', projectSettings: 'hold' }))).toBe('hold')
    expect(resolveInboundSetting(reader({ userSettings: 'hold', projectSettings: 'refuse' }))).toBe('refuse')
  })
})

test('only bypassPermissions counts as the bypass class', () => {
  expect(permissionClassOf('bypassPermissions')).toBe('bypass')
  for (const mode of ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'] as const) {
    expect(permissionClassOf(mode)).toBe('prompting')
  }
})
