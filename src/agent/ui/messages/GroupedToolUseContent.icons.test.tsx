import { describe, expect, test } from 'bun:test'
import React from 'react'
import { GroupedToolUseContent } from 'src/agent/ui/messages/GroupedToolUseContent.js'
import type { buildMessageLookups } from 'src/agent/messages/messages.js'
import type { GroupedToolUseMessage } from 'src/shared/types/message.js'
import { EXTENSION_ICONS } from 'src/terminal/fileIcons.js'
import { renderToString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import { NerdFontGlyphsContext } from 'src/terminal/terminalFont.js'
import { AgentTool } from 'src/tools/AgentTool/AgentTool.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import type { Tool, Tools } from 'src/tools/Tool.js'

// Two or more calls of a grouping tool from one turn render as one group. Its
// header carries the icons a single row of that tool does, not
// ToolUseLoader's ●.

const ROBOT = '\u{f06a9}'
const EDIT_ICON = '\u{f0dc9}'
const TS_ICON = EXTENSION_ICONS['.ts']!
// Every Nerd Font codepoint lives in a Private Use Area.
const PUA_RE = /[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}]/u
const IDS = ['toolu_a', 'toolu_b']

function group(toolName: string, input: (id: string) => Record<string, unknown>, output?: unknown): GroupedToolUseMessage {
  return {
    type: 'grouped_tool_use',
    toolName,
    messages: IDS.map(id => ({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id, name: toolName, input: input(id) }] },
    })),
    results: output === undefined
      ? []
      : IDS.map(id => ({
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
          toolUseResult: output,
        })),
  } as unknown as GroupedToolUseMessage
}

function renderGroup(
  tool: Tool,
  message: GroupedToolUseMessage,
  { glyphs, running = false }: { glyphs: boolean; running?: boolean },
): Promise<string> {
  const lookups = {
    resolvedToolUseIDs: new Set(IDS),
    erroredToolUseIDs: new Set(),
    progressMessagesByToolUseID: new Map(),
  } as unknown as ReturnType<typeof buildMessageLookups>
  return renderToString(
    <AppStateProvider>
      <NerdFontGlyphsContext.Provider value={glyphs}>
        <GroupedToolUseContent
          message={message}
          tools={[tool] as Tools}
          lookups={lookups}
          inProgressToolUseIDs={new Set(running ? IDS : [])}
          shouldAnimate={false}
        />
      </NerdFontGlyphsContext.Provider>
    </AppStateProvider>,
    100,
  )
}

describe('GroupedToolUseContent — Nerd Font icons on parallel agents', () => {
  const agents = group(
    AGENT_TOOL_NAME,
    id => ({ description: `Trace ${id}`, prompt: 'p', subagent_type: 'Explore', run_in_background: true }),
    { status: 'async_launched' },
  )

  test('background agents still running show the agent icon in the dot’s place', async () => {
    const out = await renderGroup(AgentTool, agents, { glyphs: true, running: true })
    expect(out.trimStart().startsWith(`${ROBOT} 2 background agents launched`)).toBe(true)
    expect(out).not.toContain('●')
  })

  test('a finished group keeps the icon', async () => {
    const out = await renderGroup(AgentTool, agents, { glyphs: true })
    expect(out.trimStart().startsWith(`${ROBOT} 2 background agents launched`)).toBe(true)
  })

  test('without a Nerd Font the header keeps its dot', async () => {
    const out = await renderGroup(AgentTool, agents, { glyphs: false })
    expect(out.trimStart().startsWith('● 2 background agents launched')).toBe(true)
    expect(out).not.toMatch(PUA_RE)
  })
})

describe('GroupedToolUseContent — Nerd Font icons on parallel edits', () => {
  // Two edits to one file collapse under one header; with no result yet the
  // group draws only that header.
  const path = '/repo/src/a.ts'
  const edits = group(FILE_EDIT_TOOL_NAME, id => ({ file_path: path, old_string: id, new_string: `${id}!` }))

  test('the shared header shows the edit icon and the file icon, as a single Edit row does', async () => {
    const out = await renderGroup(FileEditTool, edits, { glyphs: true })
    expect(out.trimStart().startsWith(`${EDIT_ICON} Update(${TS_ICON} ${path})`)).toBe(true)
    expect(out).not.toContain('●')
    expect(out.match(new RegExp(PUA_RE.source, 'gu'))).toHaveLength(2)
  })

  test('without a Nerd Font the header keeps its dot and no file icon', async () => {
    const out = await renderGroup(FileEditTool, edits, { glyphs: false })
    expect(out.trimStart().startsWith(`● Update(${path})`)).toBe(true)
    expect(out).not.toMatch(PUA_RE)
  })
})
