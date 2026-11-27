/**
 * Skills an MCP server publishes through the Skills extension (SEP-2640,
 * `io.modelcontextprotocol/skills`), as Claudin skill commands. Both protocol
 * eras carry it; the server declares it in `capabilities.extensions`.
 *
 * A server's skills are listed on connect and again on
 * `notifications/resources/list_changed` (the extension has no list_changed of
 * its own), unless the server's config sets `extensions.skills: false`. Each
 * one becomes a `loadedFrom: 'mcp'` command named `<server>:<skill>`. Two
 * skills of one server with the same name are told apart by the path segments
 * above them (`srv:acme:deploy`, `srv:ops:deploy`): a skill is identified by
 * (server, SKILL.md URI), never by its name.
 *
 * The listing needs only the entry's frontmatter. SKILL.md is read when the
 * skill is invoked, through `SkillsClient.read`, which checks it against the
 * entry's size, digest and frontmatter; a file that fails is not loaded and the
 * model is told so instead. A remote skill gets the processing a disk skill
 * gets minus everything that touches this machine: no inline shell, no base
 * directory, and its `allowed-tools` and `hooks` are ignored (see
 * createSkillCommand). Left out: entries the SDK refuses, and `"dynamic"`
 * skills, whose files nothing can verify.
 *
 * A skill's other files are read with ReadMcpResourceTool, which asks
 * findLoadedMcpSkill first: a URI under a loaded skill's directory is read
 * through `SkillsClient.read` (verified), and refused when the skill's
 * manifest does not list it.
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import type { Client, ReadResourceResult } from '@modelcontextprotocol/client'
import {
  type Skill,
  type SkillFile,
  type SkillListing,
  SkillsClient,
  SkillVerificationError,
} from '@modelcontextprotocol/client/ext/skills'
import { skillsCapabilityOf } from '@modelcontextprotocol/core/ext/skills'
import { getMcpExtensionEnabled } from 'src/mcp/client/serverOptions.js'
import { normalizeNameForMCP } from 'src/mcp/normalization.js'
import type { ConnectedMCPServer } from 'src/mcp/types.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { FrontmatterData } from 'src/shared/frontmatterParser.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import type { Command, PromptCommand } from 'src/shared/types/command.js'
import { getMCPSkillBuilders } from 'src/skills/mcpSkillBuilders.js'

const SKILL_MD = '/SKILL.md'

/** Reads a skill's own SKILL.md, verified. */
export type McpSkillReader = (skill: Skill) => Promise<SkillFile>

/** The skill's directory URI, without the trailing slash. */
export function mcpSkillRoot(skillUri: string): string {
  return new URL(skillUri).href.slice(0, -SKILL_MD.length)
}

/** The skill's directory as segments, the authority first: `skill://acme/deploy/SKILL.md` → acme, deploy. */
function directorySegments(skillUri: string): string[] {
  const url = new URL(skillUri)
  return [url.host, ...url.pathname.split('/')].filter(segment => segment !== '').slice(0, -1)
}

/** One group of same-named skills, each labelled with as few parent segments as tell them apart. */
function distinguish(group: readonly Skill[]): string[] {
  const paths = group.map(skill => directorySegments(skill.uri))
  const deepest = Math.max(...paths.map(segments => segments.length))
  for (let depth = 1; depth <= deepest; depth++) {
    const labels = paths.map(segments => segments.slice(-depth).join(':'))
    if (new Set(labels).size === labels.length) return labels
  }
  // The same segments under another scheme or spelling: numbered in listing order.
  const seen = new Map<string, number>()
  return paths.map(segments => {
    const label = segments.join(':')
    const n = (seen.get(label) ?? 0) + 1
    seen.set(label, n)
    return n === 1 ? label : `${label}~${n}`
  })
}

/** Each skill with its command name, in listing order. */
export function nameMcpSkills(
  serverName: string,
  skills: readonly Skill[],
): Array<{ skill: Skill; name: string }> {
  const prefix = normalizeNameForMCP(serverName)
  const groups = new Map<string, Skill[]>()
  for (const skill of skills) {
    const group = groups.get(skill.frontmatter.name)
    if (group) group.push(skill)
    else groups.set(skill.frontmatter.name, [skill])
  }
  const names = new Map<Skill, string>()
  for (const group of groups.values()) {
    const labels = distinguish(group)
    group.forEach((skill, i) => names.set(skill, `${prefix}:${labels[i]}`))
  }
  return skills.map(skill => ({ skill, name: names.get(skill) ?? '' }))
}

/** The listed skills Claudin loads: entries the SDK refused and `"dynamic"` skills are logged and left out. */
export function loadableMcpSkills(
  serverName: string,
  listing: Pick<SkillListing, 'skills' | 'invalid'>,
): Skill[] {
  for (const entry of listing.invalid) {
    logMCPDebug(serverName, `Skipped skill ${entry.uri ?? `#${entry.index}`}: ${entry.reason}`)
  }
  return listing.skills.filter(skill => {
    if (skill.resources !== 'dynamic') return true
    logMCPDebug(serverName, `Skipped skill ${skill.uri}: its files are "dynamic", so none can be verified`)
    return false
  })
}

function manifestOf(skill: Skill): Array<{ uri: string; size: number }> {
  return skill.resources === 'dynamic' ? [] : skill.resources
}

function skillPromptCommand(name: string, frontmatter: FrontmatterData, body: string): Command & PromptCommand {
  const { createSkillCommand, parseSkillFrontmatterFields } = getMCPSkillBuilders()
  const command = createSkillCommand({
    ...parseSkillFrontmatterFields(frontmatter, body, name),
    // The frontmatter name is the directory's; the command answers only to
    // its server-qualified one, so a disk skill of that name is never shadowed.
    displayName: undefined,
    // Ignored on purpose: a remote server does not get tools granted without
    // a prompt, nor hooks that run commands here (createSkillCommand also
    // drops both for loadedFrom 'mcp').
    allowedTools: [],
    hooks: undefined,
    skillName: name,
    markdownContent: body,
    source: 'mcp',
    // No inline shell runs for 'mcp', and a remote skill has no directory on
    // this machine: no "Base directory" line, no ${CLAUDIN_SKILL_DIR}.
    loadedFrom: 'mcp',
    baseDir: undefined,
    paths: undefined,
  })
  // createSkillCommand builds nothing but prompt commands.
  return command as Command & PromptCommand
}

function supportingFilesNote(serverName: string, skill: Skill): string | undefined {
  const files = manifestOf(skill).filter(file => file.uri !== skill.uri)
  if (files.length === 0) return undefined
  return [
    `This skill's other files are resources of the MCP server "${serverName}". Read one with ReadMcpResourceTool (server "${serverName}", the uri as listed):`,
    ...files.map(file => `- ${file.uri}`),
  ].join('\n')
}

function loadFailureText(name: string, serverName: string, error: unknown): string {
  if (error instanceof SkillVerificationError) {
    return `The skill "${name}" was not loaded: the SKILL.md that the MCP server "${serverName}" sent does not match the server's own listing (${error.reason}: ${error.message}). Nothing from it was used. Tell the user instead of retrying.`
  }
  return `The skill "${name}" could not be loaded from the MCP server "${serverName}": ${errorMessage(error)}`
}

/** A listed skill as a command whose prompt is SKILL.md, read and verified on invocation. */
export function buildMcpSkillCommand(
  serverName: string,
  name: string,
  skill: Skill,
  read: McpSkillReader,
): Command {
  // read() checks that SKILL.md's frontmatter equals the entry's, so the
  // entry's stands for it both here and on invocation.
  const frontmatter = skill.frontmatter as FrontmatterData
  const listed = skillPromptCommand(name, frontmatter, '')
  const ownSize = manifestOf(skill).find(file => file.uri === skill.uri)?.size ?? 0
  return {
    ...listed,
    contentLength: ownSize,
    async getPromptForCommand(args, context): Promise<ContentBlockParam[]> {
      let file: SkillFile
      try {
        file = await read(skill)
      } catch (error) {
        logMCPError(serverName, `Skill ${skill.uri} was not loaded: ${errorMessage(error)}`)
        return [{ type: 'text', text: loadFailureText(name, serverName, error) }]
      }
      const blocks = await skillPromptCommand(name, frontmatter, file.body ?? '').getPromptForCommand(args, context)
      const note = supportingFilesNote(serverName, skill)
      return note ? [...blocks, { type: 'text', text: note }] : blocks
    },
  }
}

// The skills each connected server last listed, by server name.
const loadedSkills = new Map<string, readonly Skill[]>()

/** Forget a server's skills (tests; a disconnect leaves them to the next listing). */
export function clearLoadedMcpSkills(serverName?: string): void {
  if (serverName === undefined) loadedSkills.clear()
  else loadedSkills.delete(serverName)
}

function comparableUri(uri: string): string | undefined {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    // Not a URI, so under no skill's directory.
    return undefined
  }
  url.hash = ''
  try {
    return decodeURIComponent(url.href)
  } catch (error) {
    logForDebugging(`MCP skill lookup compares ${url.href} as written: ${errorMessage(error)}`)
    return url.href
  }
}

/** The loaded skill of `serverName` whose directory holds `uri` (the innermost one), if any. */
export function findLoadedMcpSkill(serverName: string, uri: string): Skill | undefined {
  const target = comparableUri(uri)
  if (target === undefined) return undefined
  let found: Skill | undefined
  let foundRoot = ''
  for (const skill of loadedSkills.get(serverName) ?? []) {
    const root = comparableUri(mcpSkillRoot(skill.uri)) ?? ''
    if (target.startsWith(`${root}/`) && root.length > foundRoot.length) {
      found = skill
      foundRoot = root
    }
  }
  return found
}

/** A read of a skill's file that its entry does not allow: not listed, or not what the entry says. */
export class McpSkillFileRefusedError extends Error {
  override name = 'McpSkillFileRefusedError'
}

/** One file of a loaded skill, read and verified, as a resources/read result. */
export async function readMcpSkillResource(
  client: Client,
  skill: Skill,
  uri: string,
): Promise<Pick<ReadResourceResult, 'contents'>> {
  let file: SkillFile
  try {
    file = await new SkillsClient(client).read(skill, uri)
  } catch (error) {
    if (!(error instanceof SkillVerificationError)) throw error
    const listed = manifestOf(skill).map(entry => entry.uri).join(', ')
    throw new McpSkillFileRefusedError(
      error.reason === 'unlisted'
        ? `${uri} is inside the skill ${skill.uri} but not in its manifest, so it is not read. Its files: ${listed}`
        : `${uri} does not match the skill's manifest (${error.reason}: ${error.message}), so it is not used.`,
      { cause: error },
    )
  }
  const mimeType = file.mimeType === undefined ? {} : { mimeType: file.mimeType }
  return {
    contents: [
      file.text === undefined
        ? { uri: file.uri, ...mimeType, blob: Buffer.from(file.bytes).toString('base64') }
        : { uri: file.uri, ...mimeType, text: file.text },
    ],
  }
}

/**
 * The skills `connection` publishes, as commands; none when the server does
 * not declare the extension or its config turns `extensions.skills` off.
 * Records them for findLoadedMcpSkill.
 */
export async function listMcpSkillCommands(
  connection: ConnectedMCPServer,
  connect: (connection: ConnectedMCPServer) => Promise<ConnectedMCPServer>,
): Promise<Command[]> {
  // The capability check is SkillsClient.supported's (Claudin does not
  // enforce strict capabilities), read off the connection.
  if (!getMcpExtensionEnabled(connection.config, 'skills') || !skillsCapabilityOf(connection.capabilities)) {
    loadedSkills.delete(connection.name)
    return []
  }
  const listing = await new SkillsClient(connection.client, { skipInvalid: true }).list()
  const skills = loadableMcpSkills(connection.name, listing)
  loadedSkills.set(connection.name, skills)
  const read: McpSkillReader = async skill =>
    new SkillsClient((await connect(connection)).client).read(skill)
  return nameMcpSkills(connection.name, skills).map(({ skill, name }) =>
    buildMcpSkillCommand(connection.name, name, skill, read),
  )
}
