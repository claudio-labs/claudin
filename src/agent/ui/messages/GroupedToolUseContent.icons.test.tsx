import { describe, expect, test } from 'bun:test'
import React from 'react'
import { GroupedToolUseContent } from 'src/agent/ui/messages/GroupedToolUseContent.js'
import type { buildMessageLookups } from 'src/agent/messages/messages.js'
import type { GroupedToolUseMessage } from 'src/shared/types/message.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { NerdFontGlyphsContext } from 'src/terminal/terminalFont.js'
import { AgentTool } from 'src/tools/AgentTool/AgentTool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import type { Tools } from 'src/tools/Tool.js'

// Two or more Agent calls from one turn render as one group. Its header
// carries the agent icon where a single Agent row does, not ToolUseLoader's ●.

const ROBOT = '\u{f06a9}'
const IDS = ['toolu_a', 'toolu_b']

function group(): GroupedToolUseMessage {
  return {
    type: 'grouped_tool_use',
    toolName: AGENT_TOOL_NAME,
    messages: IDS.map(id => ({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id,
            name: AGENT_TOOL_NAME,
            input: { description: `Trace ${id}`, prompt: 'p', subagent_type: 'Explore', run_in_background: true },
          },
        ],
      },
    })),
    results: IDS.map(id => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'launched' }] },
      toolUseResult: { status: 'async_launched' },
    })),
  } as unknown as GroupedToolUseMessage
}

function renderGroup({ glyphs, running }: { glyphs: boolean; running: boolean }): Promise<string> {
  const lookups = {
    resolvedToolUseIDs: new Set(IDS),
    erroredToolUseIDs: new Set(),
    progressMessagesByToolUseID: new Map(),
  } as unknown as ReturnType<typeof buildMessageLookups>
  return renderToString(
    <AppStateProvider>
      <NerdFontGlyphsContext.Provider value={glyphs}>
        <GroupedToolUseContent
          message={group()}
          tools={[AgentTool] as Tools}
          lookups={lookups}
          inProgressToolUseIDs={new Set(running ? IDS : [])}
          shouldAnimate={false}
        />
      </NerdFontGlyphsContext.Provider>
    </AppStateProvider>,
    100,
  )
}

describe('GroupedToolUseContent — Nerd Font icons', () => {
  test('background agents still running show the agent icon in the dot’s place', async () => {
    const out = await renderGroup({ glyphs: true, running: true })
    expect(out.trimStart().startsWith(`${ROBOT} 2 background agents launched`)).toBe(true)
    expect(out).not.toContain('●')
  })

  test('a finished group keeps the icon', async () => {
    const out = await renderGroup({ glyphs: true, running: false })
    expect(out.trimStart().startsWith(`${ROBOT} 2 background agents launched`)).toBe(true)
  })

  test('without a Nerd Font the header keeps its dot', async () => {
    const out = await renderGroup({ glyphs: false, running: false })
    expect(out.trimStart().startsWith('● 2 background agents launched')).toBe(true)
    expect(out).not.toContain(ROBOT)
  })
})
