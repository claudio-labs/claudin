import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/Tool.js'
import { BriefTool, isBriefEnabled, isBriefEntitled } from 'src/tools/BriefTool/BriefTool.js'

function makeCtx(): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => ({ replBridgeEnabled: false }),
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('BriefTool', () => {
  test('flags: read-only, concurrency-safe', () => {
    expect(BriefTool.isReadOnly?.()).toBe(true)
    expect(BriefTool.isConcurrencySafe?.()).toBe(true)
  })

  test('userFacingName is empty (rendered by UI helpers)', () => {
    expect(BriefTool.userFacingName()).toBe('')
  })

  test('aliases preserve the legacy SendUserMessage name', () => {
    expect(BriefTool.aliases?.length).toBeGreaterThan(0)
  })

  test('input schema requires message and status; status is enum', () => {
    expect(BriefTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      BriefTool.inputSchema.safeParse({ message: 'hi' }).success,
    ).toBe(false)
    expect(
      BriefTool.inputSchema.safeParse({
        message: 'hi',
        status: 'unknown',
      }).success,
    ).toBe(false)
    expect(
      BriefTool.inputSchema.safeParse({
        message: 'hi',
        status: 'normal',
      }).success,
    ).toBe(true)
  })

  test('input schema rejects unknown keys', () => {
    expect(
      BriefTool.inputSchema.safeParse({
        message: 'hi',
        status: 'normal',
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput returns the message verbatim', () => {
    expect(
      BriefTool.toAutoClassifierInput?.({
        message: 'hello',
        status: 'normal',
      } as never),
    ).toBe('hello')
  })

  test('validateInput passes with no attachments', async () => {
    const result = await BriefTool.validateInput?.(
      { message: 'm', status: 'normal' } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('isBriefEntitled() and isBriefEnabled() are false in the open build', () => {
    // KAIROS/KAIROS_BRIEF are off in scripts/build.ts for the open build,
    // so both gates short-circuit to false regardless of env or app state.
    expect(isBriefEntitled()).toBe(false)
    expect(isBriefEnabled()).toBe(false)
    expect(BriefTool.isEnabled?.()).toBe(false)
  })

  test('call() returns the message and a sentAt timestamp', async () => {
    const before = Date.now()
    const { data } = await BriefTool.call(
      { message: 'hi', status: 'normal' } as never,
      makeCtx(),
    )
    expect(data.message).toBe('hi')
    expect(typeof data.sentAt).toBe('string')
    expect(new Date(data.sentAt ?? 0).getTime()).toBeGreaterThanOrEqual(
      before,
    )
  })

  test('mapToolResultToToolResultBlockParam reports attachment count', () => {
    const map = BriefTool.mapToolResultToToolResultBlockParam
    expect(map?.({ message: 'hi' }, 'u')?.content).toBe(
      'Message delivered to user.',
    )
    const withAttach = map?.(
      {
        message: 'hi',
        attachments: [
          { path: '/a.png', size: 1, isImage: true },
          { path: '/b.txt', size: 2, isImage: false },
        ],
      },
      'u',
    )
    expect(withAttach?.content).toBe(
      'Message delivered to user. (2 attachments included)',
    )
  })
})
