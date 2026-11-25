import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import chalk from 'chalk'
import React from 'react'
import { z } from 'zod/v4'
import { AssistantToolUseMessage } from 'src/agent/ui/messages/AssistantToolUseMessage.js'
import { CollapsedReadSearchContent } from 'src/agent/ui/messages/CollapsedReadSearchContent.js'
import { renderToAnsiString } from 'src/terminal/render/staticRender.js'
import { AppStateProvider } from 'src/terminal/state/AppState.js'
import type { Tool, Tools } from 'src/tools/Tool.js'

// Without a Nerd Font the tool rows and the collapsed group render exactly as
// before the icons existed. The snapshot beside this file was recorded on
// main (f54dbe71), before any of the icon code, colors included.

let savedNerdFont: string | undefined
const savedLevel = chalk.level
beforeAll(() => {
  savedNerdFont = process.env.CLAUDIN_NERD_FONT
  process.env.CLAUDIN_NERD_FONT = '0'
  chalk.level = 3
})
afterAll(() => {
  if (savedNerdFont === undefined) delete process.env.CLAUDIN_NERD_FONT
  else process.env.CLAUDIN_NERD_FONT = savedNerdFont
  chalk.level = savedLevel
})

const fakeTool = (name: string, displayName: string) =>
  ({
    name,
    inputSchema: z.object({ file_path: z.string().optional(), command: z.string().optional() }),
    userFacingName: () => displayName,
    renderToolUseMessage: (input: { file_path?: string; command?: string }) => input.file_path ?? input.command ?? '',
  }) as unknown as Tool
const EDIT = fakeTool('Edit', 'Update')
const BASH = fakeTool('Bash', 'Bash')

function renderRow(tool: Tool, input: object, columns: number, shouldShowDot: boolean, errored: boolean): Promise<string> {
  return renderToAnsiString(
    <AppStateProvider>
      <AssistantToolUseMessage
        param={{ type: 'tool_use', id: 't1', name: tool.name, input }}
        addMargin={false}
        tools={[tool] as Tools}
        commands={[]}
        verbose={false}
        inProgressToolUseIDs={new Set()}
        progressMessagesForMessage={[]}
        shouldAnimate={false}
        shouldShowDot={shouldShowDot}
        lookups={
          {
            resolvedToolUseIDs: new Set(['t1']),
            erroredToolUseIDs: new Set(errored ? ['t1'] : []),
            asyncLaunchedToolUseIDs: new Set(),
          } as unknown as React.ComponentProps<typeof AssistantToolUseMessage>['lookups']
        }
      />
    </AppStateProvider>,
    columns,
  )
}

const EMPTY_GROUP = {
  type: 'collapsed_read_search',
  searchCount: 0,
  readCount: 0,
  listCount: 0,
  replCount: 0,
  readFilePaths: [],
  searchArgs: [],
  latestDisplayHint: undefined,
  messages: [],
  displayMessage: undefined,
  uuid: 'group-1',
  timestamp: '2026-08-12T00:00:00.000Z',
}
const groupLookups = {
  erroredToolUseIDs: new Set(),
  resolvedToolUseIDs: new Set(['n1']),
  progressMessagesByToolUseID: new Map(),
  toolResultByToolUseID: new Map(),
  toolUseByToolUseID: new Map(),
} as unknown as React.ComponentProps<typeof CollapsedReadSearchContent>['lookups']

function renderGroup(overrides: object, { verbose, active, tools, columns }: { verbose: boolean; active: boolean; tools: Tool[]; columns: number }): Promise<string> {
  return renderToAnsiString(
    <AppStateProvider>
      <CollapsedReadSearchContent
        message={{ ...EMPTY_GROUP, ...overrides } as unknown as React.ComponentProps<typeof CollapsedReadSearchContent>['message']}
        inProgressToolUseIDs={new Set()}
        shouldAnimate={false}
        verbose={verbose}
        tools={tools as Tools}
        lookups={groupLookups}
        isActiveGroup={active}
      />
    </AppStateProvider>,
    columns,
  )
}

const editUse = {
  type: 'assistant',
  uuid: 'msg-n1',
  timestamp: '2026-11-24T00:00:00.000Z',
  message: {
    role: 'assistant',
    id: 'api-n1',
    content: [{ type: 'tool_use', id: 'n1', name: 'Edit', input: { file_path: '/repo/src/a.ts' } }],
  },
}

describe.each([100, 30])('without a Nerd Font, at %i columns', columns => {
  test.each([
    [true, false],
    [true, true],
    [false, false],
    [false, true],
  ])('a tool row (dot %p, error %p) is the old one', async (shouldShowDot, errored) => {
    expect(await renderRow(EDIT, { file_path: '/repo/src/agent/ui/a-long-file-name.ts' }, columns, shouldShowDot, errored)).toMatchSnapshot()
    expect(await renderRow(BASH, { command: 'ls -la /a/very/long/path' }, columns, shouldShowDot, errored)).toMatchSnapshot()
  })

  test('the collapsed badge is the old one, finished and running', async () => {
    expect(await renderGroup({ searchCount: 2, readCount: 3 }, { verbose: false, active: false, tools: [], columns })).toMatchSnapshot()
    expect(await renderGroup({ readCount: 1 }, { verbose: false, active: true, tools: [], columns })).toMatchSnapshot()
  })

  test('a row in the ctrl+o detail is the old one', async () => {
    expect(await renderGroup({ messages: [editUse] }, { verbose: true, active: false, tools: [EDIT], columns })).toMatchSnapshot()
  })
})
