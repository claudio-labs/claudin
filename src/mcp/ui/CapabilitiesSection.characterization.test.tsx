/**
 * The "Capabilities:" line of a server menu: which of tools, resources and
 * prompts a server offers, in that order, or "none".
 */
import { describe, expect, test } from 'bun:test'
import React from 'react'
import { CapabilitiesSection } from 'src/mcp/ui/CapabilitiesSection.js'
import { flat, mount, SLOW } from 'src/permissions/ui/__testutils__/promptFrameRig.js'

const line = async (tools: number, resources: number, prompts: number) => {
  const screen = await mount(
    <CapabilitiesSection serverToolsCount={tools} serverResourcesCount={resources} serverPromptsCount={prompts} />,
  )
  return flat(screen.text())
}

describe('CapabilitiesSection', () => {
  const rows: Array<[number, number, number, string]> = [
    [0, 0, 0, 'none'],
    [3, 0, 0, 'tools'],
    [0, 1, 0, 'resources'],
    [0, 0, 7, 'prompts'],
    [2, 2, 0, 'tools · resources'],
    [4, 0, 1, 'tools · prompts'],
    [0, 5, 5, 'resources · prompts'],
    [1, 1, 1, 'tools · resources · prompts'],
    [-1, -3, 0, 'none'],
  ]
  for (const [tools, resources, prompts, shown] of rows) {
    test(`tools ${tools}, resources ${resources}, prompts ${prompts}: ${shown}`, async () => {
      expect(await line(tools, resources, prompts)).toBe(`Capabilities: ${shown}`)
    }, SLOW)
  }

  test('follows new counts on the same mount', async () => {
    const screen = await mount(<CapabilitiesSection serverToolsCount={0} serverResourcesCount={0} serverPromptsCount={0} />)
    expect(flat(screen.text())).toBe('Capabilities: none')
    const seen: string[] = []
    for (const [t, r, p] of [[1, 0, 0], [1, 0, 2], [1, 0, 2], [0, 0, 0]]) {
      await screen.replace(<CapabilitiesSection serverToolsCount={t!} serverResourcesCount={r!} serverPromptsCount={p!} />)
      seen.push(flat(screen.text()))
    }
    expect(seen).toEqual([
      'Capabilities: tools',
      'Capabilities: tools · prompts',
      'Capabilities: tools · prompts',
      'Capabilities: none',
    ])
  }, SLOW)
})
