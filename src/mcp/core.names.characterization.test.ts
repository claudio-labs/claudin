/**
 * mcp/core, part 1: the names.
 *
 * Every MCP tool, prompt and permission rule is addressed by a name of the
 * shape `mcp__<server>__<tool>`. These tests pin how a raw server or tool name
 * is folded into the API-safe alphabet, how the qualified name is assembled,
 * and how a string (a rule from settings, a tool name from the wire) is split
 * back into its server and tool parts. Permission rules match on the split, so
 * the edges here are security edges: a name that splits differently from how
 * it was built is a name some rule can reach by accident.
 */
import { describe, expect, test } from 'bun:test'
import {
  buildMcpToolName,
  extractMcpToolDisplayName,
  getMcpDisplayName,
  getMcpPrefix,
  getToolNameForPermissionCheck,
  mcpInfoFromString,
} from 'src/mcp/mcpStringUtils.js'
import {
  CLAUDEAI_SERVER_PREFIX,
  isClaudeAIMcpServerName,
  normalizeNameForMCP,
} from 'src/mcp/normalization.js'

const API_NAME = /^[a-zA-Z0-9_-]*$/

describe('normalizeNameForMCP', () => {
  const folded: Array<[label: string, raw: string, out: string]> = [
    ['already safe', 'github', 'github'],
    ['keeps case, digits, dash and underscore', 'My-Srv_2', 'My-Srv_2'],
    ['a dot becomes an underscore', 'my.server', 'my_server'],
    ['a space becomes an underscore', 'my server', 'my_server'],
    ['each bad character is replaced on its own', 'a  b', 'a__b'],
    ['a slash and a colon', 'org/repo:main', 'org_repo_main'],
    ['an accented letter is one bad character', 'café', 'caf_'],
    ['an astral emoji is two UTF-16 units, so two underscores', 'a😀b', 'a__b'],
    ['runs of underscores in an ordinary name survive', 'x___y', 'x___y'],
    ['leading and trailing junk in an ordinary name survives as underscores', ' .x. ', '__x__'],
    ['the empty name stays empty', '', ''],
    ['the prefix without its space is an ordinary name', 'claude.ai', 'claude_ai'],
    ['upper-case prefix is an ordinary name', 'Claude.ai  Drive', 'Claude_ai__Drive'],
  ]
  test.each(folded)('%s', (_label, raw, out) => {
    expect(normalizeNameForMCP(raw)).toBe(out)
    expect(normalizeNameForMCP(raw)).toMatch(API_NAME)
  })

  // Connector names (the claude.ai prefix) get two extra steps: runs of
  // underscores shrink to one, and an underscore at either end is cut.
  const connectorFolds = {
    'claude.ai Google Drive': 'claude_ai_Google_Drive',
    'claude.ai  Two  Spaces': 'claude_ai_Two_Spaces',
    'claude.ai Ends Badly!': 'claude_ai_Ends_Badly',
    'claude.ai ___under___': 'claude_ai_under',
    'claude.ai ': 'claude_ai',
  }
  test('connector names never keep a doubled underscore', () => {
    const seen = Object.keys(connectorFolds).map(normalizeNameForMCP)
    expect(seen).toEqual(Object.values(connectorFolds))
    expect(seen.filter(n => n.includes('__'))).toEqual([])
  })

  test('no length cap is applied, even past the API limit of 64', () => {
    const long = 'n'.repeat(100)
    expect(normalizeNameForMCP(long)).toBe(long)
  })

  test('folding is idempotent', () => {
    for (const raw of ['my.server', 'claude.ai  X', 'a😀b', 'ok']) {
      const once = normalizeNameForMCP(raw)
      expect(normalizeNameForMCP(once)).toBe(once)
    }
  })

  test('distinct names can fold to the same name', () => {
    const family = ['my.server', 'my server', 'my_server', 'my/server', 'my:server']
    expect(new Set(family.map(normalizeNameForMCP))).toEqual(new Set(['my_server']))
  })
})

describe('claude.ai connector names', () => {
  test('the prefix is the literal "claude.ai " with its trailing space', () => {
    expect(CLAUDEAI_SERVER_PREFIX).toBe('claude.ai ')
  })

  const cases: Array<[name: string, isConnector: boolean]> = [
    ['claude.ai Slack', true],
    ['claude.ai ', true],
    ['claude.ai', false],
    ['claude.aiSlack', false],
    ['Claude.ai Slack', false],
    [' claude.ai Slack', false],
    ['my claude.ai Slack', false],
    ['', false],
  ]
  test.each(cases)('%p is a connector: %p', (name, isConnector) => {
    expect(isClaudeAIMcpServerName(name)).toBe(isConnector)
  })
})

describe('building qualified names', () => {
  const built: Array<[server: string, tool: string, prefix: string, full: string]> = [
    ['github', 'create_issue', 'mcp__github__', 'mcp__github__create_issue'],
    ['my.server', 'read file', 'mcp__my_server__', 'mcp__my_server__read_file'],
    ['claude.ai Google Drive', 'search', 'mcp__claude_ai_Google_Drive__', 'mcp__claude_ai_Google_Drive__search'],
    ['srv', 'ns.tool/v2', 'mcp__srv__', 'mcp__srv__ns_tool_v2'],
    ['srv', '', 'mcp__srv__', 'mcp__srv__'],
    ['', 'tool', 'mcp____', 'mcp____tool'],
  ]
  test.each(built)('server %p + tool %p', (server, tool, prefix, full) => {
    expect(getMcpPrefix(server)).toBe(prefix)
    expect(buildMcpToolName(server, tool)).toBe(full)
  })

  test('a tool name is folded by the ordinary rule even when the server is a connector', () => {
    expect(buildMcpToolName('claude.ai X', 'a  b')).toBe('mcp__claude_ai_X__a__b')
  })
})

describe('parsing a string into server and tool', () => {
  type Parsed = { serverName: string; toolName: string | undefined } | null
  const parsed: Array<[input: string, out: Parsed]> = [
    ['mcp__github__create_issue', { serverName: 'github', toolName: 'create_issue' }],
    ['mcp__github', { serverName: 'github', toolName: undefined }],
    ['mcp__github__*', { serverName: 'github', toolName: '*' }],
    ['mcp__github__', { serverName: 'github', toolName: '' }],
    ['mcp__a__b__c', { serverName: 'a', toolName: 'b__c' }],
    ['mcp__a____b', { serverName: 'a', toolName: '__b' }],
    ['mcp__a___b', { serverName: 'a', toolName: '_b' }],
    ['mcp___a', { serverName: '_a', toolName: undefined }],
    ['mcp__srv__tool(arg)', { serverName: 'srv', toolName: 'tool(arg)' }],
    ['mcp__', null],
    ['mcp____tool', null],
    ['mcp', null],
    ['mcp_github', null],
    ['MCP__github__x', null],
    ['xmcp__github__x', null],
    [' mcp__github__x', null],
    ['Bash', null],
    ['', null],
  ]
  test.each(parsed)('%p', (input, out) => {
    expect(mcpInfoFromString(input)).toEqual(out)
  })

  test('a built name parses back to its normalized parts when neither holds a double underscore', () => {
    const pairs: Array<[string, string]> = [
      ['github', 'create_issue'],
      ['my.server', 'list'],
      ['claude.ai Slack', 'post message'],
    ]
    for (const [server, tool] of pairs) {
      expect(mcpInfoFromString(buildMcpToolName(server, tool))).toEqual({
        serverName: normalizeNameForMCP(server),
        toolName: normalizeNameForMCP(tool),
      })
    }
  })

  // Security edge, kept for parity: the split takes the FIRST "__" after the
  // prefix as the server/tool boundary, so a server whose folded name holds
  // "__" is read back as a shorter server. A rule written for that shorter
  // server reaches it.
  const collisions: Array<[label: string, server: string, tool: string, readAs: string, toolRead: string]> = [
    ['an underscore pair in the server name', 'team__ops', 'deploy', 'team', 'ops__deploy'],
    ['two spaces fold into the delimiter', 'team  ops', 'deploy', 'team', 'ops__deploy'],
    ['two dots fold into the delimiter', 'team..ops', 'deploy', 'team', 'ops__deploy'],
    ['one astral emoji folds into the delimiter', 'team😀ops', 'deploy', 'team', 'ops__deploy'],
  ]
  test.each(collisions)('%s: the server is read back as the shorter name', (_label, server, tool, readAs, toolRead) => {
    expect(mcpInfoFromString(buildMcpToolName(server, tool))).toEqual({ serverName: readAs, toolName: toolRead })
  })

  test('a connector name never produces the delimiter, so it always parses back whole', () => {
    expect(mcpInfoFromString(buildMcpToolName('claude.ai  Team  Ops', 'deploy'))).toEqual({
      serverName: 'claude_ai_Team_Ops',
      toolName: 'deploy',
    })
  })
})

describe('the name a permission rule is matched against', () => {
  const cases: Array<[label: string, tool: { name: string; mcpInfo?: { serverName: string; toolName: string } }, out: string]> = [
    ['a builtin keeps its own name', { name: 'Write' }, 'Write'],
    ['a prefixed MCP tool keeps its qualified name', { name: 'mcp__fs__read', mcpInfo: { serverName: 'fs', toolName: 'read' } }, 'mcp__fs__read'],
    [
      'an MCP tool shown under a builtin name is still matched by its qualified name',
      { name: 'Write', mcpInfo: { serverName: 'fs', toolName: 'Write' } },
      'mcp__fs__Write',
    ],
    [
      'the qualified name is rebuilt from the raw parts, folded',
      { name: 'anything', mcpInfo: { serverName: 'my.server', toolName: 'do it' } },
      'mcp__my_server__do_it',
    ],
    ['a name that only looks like MCP, without mcpInfo, is used as is', { name: 'mcp__x__y' }, 'mcp__x__y'],
  ]
  test.each(cases)('%s', (_label, tool, out) => {
    expect(getToolNameForPermissionCheck(tool)).toBe(out)
  })
})

describe('display names', () => {
  const stripped: Array<[full: string, server: string, out: string]> = [
    ['mcp__github__create_issue', 'github', 'create_issue'],
    ['mcp__my_server__list', 'my.server', 'list'],
    ['mcp__claude_ai_Slack__post', 'claude.ai Slack', 'post'],
    ['mcp__other__list', 'github', 'mcp__other__list'],
    ['create_issue', 'github', 'create_issue'],
    ['x_mcp__github__tool', 'github', 'x_tool'],
    ['mcp__github__a_mcp__github__b', 'github', 'a_mcp__github__b'],
  ]
  test.each(stripped)('%p without the prefix of server %p is %p', (full, server, out) => {
    expect(getMcpDisplayName(full, server)).toBe(out)
  })

  // The user-facing label is "<server> - <tool> (MCP)". What is shown is the
  // part after the first " - ", with the "(MCP)" tag and outer spaces gone.
  const shownAs = new Map<string, string>([
    ['github - Add comment to issue (MCP)', 'Add comment to issue'],
    ['github - Add comment (MCP)   ', 'Add comment'],
    ['github - Add comment   (MCP)', 'Add comment'],
    ['github -   padded   (MCP)', 'padded'],
    ['Add comment (MCP)', 'Add comment'],
    ['Add comment(MCP)', 'Add comment'],
    ['  bare name  ', 'bare name'],
    ['srv - a - b (MCP)', 'a - b'],
    ['srv-no-spaces (MCP)', 'srv-no-spaces'],
    ['srv - tool (mcp)', 'tool (mcp)'],
    ['srv - (MCP) inside', '(MCP) inside'],
    ['(MCP)', ''],
    ['', ''],
  ])
  test('user-facing labels reduce to the tool part', () => {
    const got = new Map([...shownAs.keys()].map(label => [label, extractMcpToolDisplayName(label)]))
    expect(got).toEqual(shownAs)
  })
})
