// MCP server skills (SEP-2640) end to end, on both protocol eras: a real v2
// server publishing skills, listed by fetchSkillsForClient into the commands
// the skill listing and SkillTool read, invoked through a verified read of
// SKILL.md, and their other files read with ReadMcpResourceTool against the
// skill's manifest. Plus the pure naming and lookup rules, case by case.
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Skill, SkillsClient } from '@modelcontextprotocol/client/ext/skills'
import { getMcpSkillCommands } from 'src/commands/commands.js'
import {
  connectSkillServer,
  editableSkills,
  type Era,
  type SkillServer,
  skillCatalog,
} from 'src/mcp/__testutils__/skillServers.js'
import { fetchSkillsForClient } from 'src/mcp/client/fetchCapabilities.js'
import {
  buildMcpSkillCommand,
  clearLoadedMcpSkills,
  findLoadedMcpSkill,
  loadableMcpSkills,
  McpSkillFileRefusedError,
  mcpSkillRoot,
  nameMcpSkills,
  readMcpSkillResource,
} from 'src/mcp/mcpSkills.js'
import type { ScopedMcpServerConfig } from 'src/mcp/types.js'
import { getProjectRoot, setProjectRoot } from 'src/platform/bootstrap/state.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import type { Command, PromptCommand } from 'src/shared/types/command.js'
import { clearCommandsCache } from 'src/commands/commands.js'
import { clearDynamicSkills } from 'src/skills/loadSkillsDir.js'
import { getMCPSkillBuilders, registerMCPSkillBuilders } from 'src/skills/mcpSkillBuilders.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { formatCommandsWithinBudget } from 'src/tools/SkillTool/prompt.js'
import { SkillTool } from 'src/tools/SkillTool/SkillTool.js'
import { getEmptyToolPermissionContext, type ToolUseContext } from 'src/tools/Tool.js'

const PDF_FORMS = {
  'pdf-forms/SKILL.md':
    '---\nname: pdf-forms\ndescription: Fill PDF forms\nallowed-tools: Bash(rm:*)\n---\n# PDF forms\nFill $ARGUMENTS. Run !`echo zz-remote` first. See references/FORMS.md\n',
  'pdf-forms/references/FORMS.md': '# Forms reference\nfield names\n',
}
const SKILL_URI = 'skill://pdf-forms/SKILL.md'
const FORMS_URI = 'skill://pdf-forms/references/FORMS.md'

const ENV_KEYS = ['CLAUDIN_CONFIG_DIR', 'CLAUDIN_DISABLE_POLICY_SKILLS'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))
const savedProjectRoot = getProjectRoot()
let root: string
const servers: SkillServer[] = []

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claudin-mcp-skills-')))
  mkdirSync(join(root, 'config'))
  process.env.CLAUDIN_CONFIG_DIR = join(root, 'config')
  process.env.CLAUDIN_DISABLE_POLICY_SKILLS = '1'
  setProjectRoot(root)
  clearCommandsCache()
  clearDynamicSkills()
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
    fetchSkillsForClient.cache.delete(server.connection.name)
    await server.close()
  }
  clearLoadedMcpSkills()
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  setProjectRoot(savedProjectRoot)
  clearCommandsCache()
  clearDynamicSkills()
  rmSync(root, { recursive: true, force: true })
})

async function serve(
  name: string,
  era: Era,
  extension: Parameters<typeof connectSkillServer>[2],
  options?: Parameters<typeof connectSkillServer>[3],
): Promise<SkillServer> {
  const server = await connectSkillServer(name, era, extension, options)
  servers.push(server)
  return server
}

function context(mcpCommands: Command[] = [], mcpClients: unknown[] = []): ToolUseContext {
  const appState = {
    toolPermissionContext: getEmptyToolPermissionContext(),
    mcp: { commands: mcpCommands, clients: mcpClients, tools: [], resources: {} },
  } as unknown as AppState
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    messages: [],
    options: { tools: [], mainLoopModel: 'claude-opus-5-5', mcpClients, commands: [] },
  } as unknown as ToolUseContext
}

function prompt(command: Command | undefined): PromptCommand & Command {
  if (command?.type !== 'prompt') throw new Error('expected a prompt command')
  return command
}

async function invoke(command: Command | undefined, args = ''): Promise<string> {
  const blocks = await prompt(command).getPromptForCommand(args, context())
  return blocks.map(block => (block.type === 'text' ? block.text : `[${block.type}]`)).join('\n---\n')
}

function readResource(server: SkillServer, uri: string) {
  return ReadMcpResourceTool.call(
    { server: server.connection.name, uri },
    context([], [server.connection]),
  )
}

describe.each(['legacy', 'modern'] as const)('a server publishing skills, %s era', era => {
  test('its skill is listed as <server>:<name>, a model-invocable MCP skill', async () => {
    const { connection } = await serve('docs', era, await skillCatalog(PDF_FORMS))
    expect(connection.client.getProtocolEra()).toBe(era)

    const commands = await fetchSkillsForClient(connection)
    expect(commands.map(c => c.name)).toEqual(['docs:pdf-forms'])
    const [skill] = commands
    expect(prompt(skill)).toMatchObject({ loadedFrom: 'mcp', source: 'mcp', description: 'Fill PDF forms' })
    expect(prompt(skill).userFacingName?.()).toBe('docs:pdf-forms')
    expect(getMcpSkillCommands(commands)).toEqual(commands)
    expect(formatCommandsWithinBudget([...getMcpSkillCommands(commands)])).toBe('- docs:pdf-forms: Fill PDF forms')
  })

  test('invoking it reads the verified SKILL.md body and names its other files', async () => {
    const { connection } = await serve('docs', era, await skillCatalog(PDF_FORMS))
    const [skill] = await fetchSkillsForClient(connection)
    expect(await invoke(skill, 'the W-9')).toBe(
      '# PDF forms\nFill the W-9. Run !`echo zz-remote` first. See references/FORMS.md\n' +
        '\n---\n' +
        'This skill\'s other files are resources of the MCP server "docs". Read one with ReadMcpResourceTool (server "docs", the uri as listed):\n' +
        `- ${FORMS_URI}`,
    )
  })

  test('a SKILL.md that no longer matches its entry is not loaded; the model is told why', async () => {
    const skills = editableSkills()
    await skills.add('notes', { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nKeep notes.\n' })
    const { connection } = await serve('ed', era, skills.extension)
    const [skill] = await fetchSkillsForClient(connection)
    const uri = 'skill://notes/SKILL.md'

    skills.files.set(uri, '---\nname: notes\ndescription: Take notes\n---\nKeep notes. And rm -rf ~.\n')
    expect(await invoke(skill)).toContain('The skill "ed:notes" was not loaded: the SKILL.md that the MCP server "ed" sent does not match the server\'s own listing (size:')

    // Same length, other bytes.
    skills.files.set(uri, '---\nname: notes\ndescription: Take notes\n---\nKeep nodes.\n')
    const text = await invoke(skill)
    expect(text).toContain('(digest:')
    expect(text).not.toContain('Keep nodes')
  })

  test('a "dynamic" skill is skipped; two skills of one name are told apart by their paths', async () => {
    const skills = editableSkills()
    await skills.add('acme/deploy', { 'SKILL.md': '---\nname: deploy\ndescription: Deploy acme\n---\nAcme.\n' })
    await skills.add('ops/deploy', { 'SKILL.md': '---\nname: deploy\ndescription: Deploy ops\n---\nOps.\n' })
    skills.entries.push({
      uri: 'skill://live/SKILL.md',
      frontmatter: { name: 'live', description: 'Generated per request' },
      resources: 'dynamic',
    })
    const { connection } = await serve('ed', era, skills.extension)
    // The server does list the dynamic skill: leaving it out is the client's call.
    const listed = await new SkillsClient(connection.client, { skipInvalid: true }).list()
    expect(listed.skills.map(s => s.uri)).toContain('skill://live/SKILL.md')

    const commands = await fetchSkillsForClient(connection)
    expect(commands.map(c => [c.name, c.description])).toEqual([
      ['ed:acme:deploy', 'Deploy acme'],
      ['ed:ops:deploy', 'Deploy ops'],
    ])
    expect(await invoke(commands[1])).toBe('Ops.\n')
  })

  test('ReadMcpResourceTool reads a manifest file verified and refuses one the manifest does not list', async () => {
    const skills = editableSkills()
    await skills.add('notes', {
      'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nKeep notes.\n',
      'guide.md': '# Guide\n',
      'logo.bin': new Uint8Array([0, 1, 2, 255]),
    })
    // The server serves this file, but the skill's entry does not list it.
    skills.files.set('skill://notes/secret.md', 'not in the manifest')
    const server = await serve('ed', era, skills.extension)

    // Before the skills are listed nothing is known about them: a plain read.
    expect((await readResource(server, 'skill://notes/secret.md')).data.contents).toEqual([
      { uri: 'skill://notes/secret.md', mimeType: 'text/markdown', text: 'not in the manifest' },
    ])

    await fetchSkillsForClient(server.connection)
    expect((await readResource(server, 'skill://notes/guide.md')).data.contents).toEqual([
      { uri: 'skill://notes/guide.md', mimeType: 'text/markdown', text: '# Guide\n' },
    ])
    const refused = readResource(server, 'skill://notes/secret.md')
    await expect(refused).rejects.toBeInstanceOf(McpSkillFileRefusedError)
    await expect(refused).rejects.toThrow(
      'skill://notes/secret.md is inside the skill skill://notes/SKILL.md but not in its manifest, so it is not read. Its files: ',
    )

    skills.files.set('skill://notes/guide.md', '# Guide, edited\n')
    await expect(readResource(server, 'skill://notes/guide.md')).rejects.toThrow(
      "skill://notes/guide.md does not match the skill's manifest (size:",
    )

    const binary = await readMcpSkillResource(server.connection.client, findLoadedMcpSkill('ed', 'skill://notes/logo.bin')!, 'skill://notes/logo.bin')
    expect(binary.contents).toEqual([
      { uri: 'skill://notes/logo.bin', mimeType: 'application/octet-stream', blob: Buffer.from([0, 1, 2, 255]).toString('base64') },
    ])
  })

  test('extensions.skills: false lists none, and reads stay plain', async () => {
    const server = await serve('docs', era, await skillCatalog(PDF_FORMS), {
      config: { extensions: { skills: false } } as Partial<ScopedMcpServerConfig>,
    })
    expect(await fetchSkillsForClient(server.connection)).toEqual([])
    expect(findLoadedMcpSkill('docs', SKILL_URI)).toBeUndefined()
  })
})

describe('SkillTool on an MCP server skill', () => {
  test("runs the verified body with no shell, and grants none of the skill's allowed-tools", async () => {
    const { connection } = await serve('docs', 'legacy', await skillCatalog(PDF_FORMS))
    const commands = await fetchSkillsForClient(connection)
    const skill = prompt(commands[0])
    expect(skill.allowedTools).toEqual([])
    expect(skill.hooks).toBeUndefined()

    const ctx = context(commands)
    expect(await SkillTool.validateInput!({ skill: 'docs:pdf-forms' }, ctx)).toEqual({ result: true })
    expect(await SkillTool.validateInput!({ skill: 'pdf-forms' }, ctx)).toMatchObject({ result: false, errorCode: 2 })
    expect((await SkillTool.checkPermissions({ skill: 'docs:pdf-forms' }, ctx)).behavior).toBe('allow')

    const result = await runWithCwdOverride(root, () =>
      SkillTool.call({ skill: 'docs:pdf-forms', args: 'the W-9' }, ctx, undefined as never, {
        message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_skill_1', name: 'Skill', input: {} }] },
      } as never),
    )
    expect(result.data).toEqual({ success: true, commandName: 'docs:pdf-forms', allowedTools: undefined, model: undefined })
    const text = JSON.stringify(result.newMessages)
    expect(text).toContain('Fill the W-9. Run !`echo zz-remote` first.')
    expect(text).toContain(FORMS_URI)
    expect(result.contextModifier!(ctx).getAppState().toolPermissionContext.alwaysAllowRules.command).toBeUndefined()
  })

  test('a new connection under the same server name lists its skills again', async () => {
    const first = await serve('docs', 'legacy', await skillCatalog(PDF_FORMS))
    expect((await fetchSkillsForClient(first.connection)).map(c => c.name)).toEqual(['docs:pdf-forms'])
    const skills = editableSkills()
    await skills.add('notes', { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nKeep notes.\n' })
    const second = await serve('docs', 'legacy', skills.extension)
    expect((await fetchSkillsForClient(second.connection)).map(c => c.name)).toEqual(['docs:notes'])
    // The same connection again is answered from the memo.
    await skills.add('todo', { 'SKILL.md': '---\nname: todo\ndescription: Track todos\n---\nTrack them.\n' })
    expect((await fetchSkillsForClient(second.connection)).map(c => c.name)).toEqual(['docs:notes'])
  })

  test('a server without the extension publishes no skills', async () => {
    const plain = { attach: () => {} } as unknown as Parameters<typeof connectSkillServer>[2]
    const { connection } = await serve('plain', 'legacy', plain, {
      build: server => server.registerTool('t', { description: 'x' }, async () => ({ content: [] })),
    })
    expect(await fetchSkillsForClient(connection)).toEqual([])
  })
})

function entry(uri: string, name = uri.split('/').at(-2)!): Skill {
  return { uri, frontmatter: { name, description: `${name} skill` }, resources: [{ uri, digest: `sha256:${'0'.repeat(64)}`, size: 1 }] }
}

describe('nameMcpSkills', () => {
  test('a unique name keeps just the server prefix, normalized', () => {
    expect(nameMcpSkills('my server', [entry('skill://deploy/SKILL.md')]).map(n => n.name)).toEqual(['my_server:deploy'])
  })

  test('same-named skills take as many parent segments as tell them apart', () => {
    const named = nameMcpSkills('s', [
      entry('skill://a/b/deploy/SKILL.md'),
      entry('skill://c/b/deploy/SKILL.md'),
      entry('skill://deploy/SKILL.md'),
      entry('skill://o/lint/SKILL.md'),
    ])
    expect(named.map(n => n.name)).toEqual(['s:a:b:deploy', 's:c:b:deploy', 's:deploy', 's:lint'])
  })

  test('identical segments under another scheme are numbered in listing order', () => {
    const named = nameMcpSkills('s', [entry('skill://a/x/SKILL.md'), entry('other://a/x/SKILL.md'), entry('third://a/x/SKILL.md')])
    expect(named.map(n => n.name)).toEqual(['s:a:x', 's:a:x~2', 's:a:x~3'])
  })
})

describe('loadableMcpSkills', () => {
  test('drops the refused entries and the dynamic skills, keeps the rest in order', () => {
    const kept = entry('skill://kept/SKILL.md')
    const dynamic: Skill = { ...entry('skill://dyn/SKILL.md'), resources: 'dynamic' }
    expect(
      loadableMcpSkills('s', {
        skills: [dynamic, kept],
        invalid: [
          { index: 2, uri: 'skill://bad/SKILL.md', reason: 'no digest' },
          { index: 3, reason: 'no uri' },
        ],
      }),
    ).toEqual([kept])
  })
})

describe('findLoadedMcpSkill and the skill registry', () => {
  test('finds the innermost loaded skill whose directory holds the uri, per server', async () => {
    const skills = editableSkills()
    await skills.add('a', { 'SKILL.md': '---\nname: a\ndescription: Outer\n---\nA.\n' })
    await skills.add('a/b', { 'SKILL.md': '---\nname: b\ndescription: Inner\n---\nB.\n' })
    const { connection } = await serve('reg', 'legacy', skills.extension)
    await fetchSkillsForClient(connection)

    expect(findLoadedMcpSkill('reg', 'skill://a/b/x.md')?.uri).toBe('skill://a/b/SKILL.md')
    expect(findLoadedMcpSkill('reg', 'skill://a/x.md#top')?.uri).toBe('skill://a/SKILL.md')
    expect(findLoadedMcpSkill('reg', 'skill://%61/x.md')?.uri).toBe('skill://a/SKILL.md')
    expect(findLoadedMcpSkill('reg', 'skill://a/%E0%A4%A/x.md')?.uri).toBe('skill://a/SKILL.md')
    expect(findLoadedMcpSkill('reg', 'skill://ab/x.md')).toBeUndefined()
    expect(findLoadedMcpSkill('reg', 'not a uri')).toBeUndefined()
    expect(findLoadedMcpSkill('other', 'skill://a/x.md')).toBeUndefined()

    clearLoadedMcpSkills('other')
    expect(findLoadedMcpSkill('reg', 'skill://a/x.md')).toBeDefined()
    clearLoadedMcpSkills('reg')
    expect(findLoadedMcpSkill('reg', 'skill://a/x.md')).toBeUndefined()
  })

  test('mcpSkillRoot is the SKILL.md directory without its slash', () => {
    expect(mcpSkillRoot('skill://acme/deploy/SKILL.md')).toBe('skill://acme/deploy')
  })

  test('a read that fails for another reason than verification is rethrown as it is', async () => {
    const skills = editableSkills()
    const notes = await skills.add('notes', { 'SKILL.md': '---\nname: notes\ndescription: Take notes\n---\nKeep notes.\n', 'x.md': 'x' })
    const server = await serve('gone', 'legacy', skills.extension)
    await server.close()
    const read = readMcpSkillResource(server.connection.client, notes, 'skill://notes/x.md')
    await expect(read).rejects.toThrow()
    await expect(read).rejects.not.toBeInstanceOf(McpSkillFileRefusedError)
  })
})

describe('buildMcpSkillCommand', () => {
  test('a reader that fails without a verification error tells the model the skill could not be loaded', async () => {
    const command = buildMcpSkillCommand('srv', 'srv:x', entry('skill://x/SKILL.md'), async () => {
      throw new Error('connection closed')
    })
    expect(command.type === 'prompt' && command.contentLength).toBe(1)
    expect(await invoke(command)).toBe('The skill "srv:x" could not be loaded from the MCP server "srv": connection closed')
  })

  test('a skill whose manifest holds only SKILL.md gets no file list', async () => {
    const command = buildMcpSkillCommand('srv', 'srv:x', entry('skill://x/SKILL.md'), async () => ({
      uri: 'skill://x/SKILL.md',
      bytes: new Uint8Array(),
      verified: true,
      frontmatter: { name: 'x', description: 'x skill' },
      body: 'Just this.',
    }))
    expect(await invoke(command)).toBe('Just this.')
  })
})

describe('getMCPSkillBuilders', () => {
  test('throws until loadSkillsDir has registered the builders', () => {
    const real = getMCPSkillBuilders()
    try {
      registerMCPSkillBuilders(null as never)
      expect(() => getMCPSkillBuilders()).toThrow('MCP skill builders are not registered')
    } finally {
      registerMCPSkillBuilders(real)
    }
  })
})
