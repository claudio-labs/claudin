import { relative, sep } from 'path'

import type { MemoryFileInfo } from 'src/memory/instructions/claudemd.js'
import { encodeBrowseValue, TIDY_VALUE } from 'src/memory/ui/memoryDirRows.js'
import { getProjectMemoryPathForSelector } from 'src/memory/ui/memoryFileSelectorPaths.js'
import type { AgentMemoryScope } from 'src/tools/AgentTool/agentMemory.js'

export type SelectorRow = {
  label: string
  value: string
  description?: string
  /** A leading part of `label` the view shows in bold. */
  emphasis?: string
}

type SelectorAgent = {
  agentType: string
  memory?: AgentMemoryScope
}

export type SelectorRowInput = {
  loadedFiles: readonly MemoryFileInfo[]
  startDir: string
  userFilePath: string
  inGitRepo: boolean
  autoMemoryOn: boolean
  privateDir: string
  /** `null` when team memory is off or not built in. */
  teamDir: string | null
  counts?: { private: number; team: number }
  agents: readonly SelectorAgent[]
}

export type SelectorRowDeps = {
  displayPath: (path: string) => string
  agentMemoryDir: (agentType: string, scope: AgentMemoryScope) => string
}

/** What each kind of loaded instruction file carries beyond its path. */
type FileKindPayload = {
  user: Record<never, never>
  project: Record<never, never>
  import: { depth: number }
  other: Record<never, never>
}

/** How a loaded instruction file is presented. */
type FileKind<K extends keyof FileKindPayload = keyof FileKindPayload> = {
  [P in K]: { kind: P } & FileKindPayload[P]
}[K]

type RowText = { label: string; description?: string }

type FileContext = {
  path: string
  input: SelectorRowInput
  deps: SelectorRowDeps
}

// The user file's description stays this fixed text even when CLAUDIN_CONFIG_DIR
// moves the file: the characterization pins it, and the spec keeps it for parity.
const USER_FILE_NOTE = 'Saved in ~/.claudin/CLAUDE.md'
const IMPORT_NOTE = '@-imported'
const TIDY_NOTE = 'Merge duplicate memories and rebuild the index'

const PRIVATE_TITLE = 'Private memory'
const TEAM_TITLE = 'Team memory'

/** Where the project file sits, as seen from the start directory: `./AGENTS.md`, `../AGENTS.md`. */
function fromStartDir(startDir: string, path: string): string {
  const rel = relative(startDir, path)
  return rel === '..' || rel.startsWith(`..${sep}`) ? rel : `./${rel}`
}

const FILE_ROW_TEXT: { [K in keyof FileKindPayload]: (kind: FileKind<K>, ctx: FileContext) => RowText } = {
  user: () => ({ label: 'User memory', description: USER_FILE_NOTE }),
  project: (_kind, { path, input }) => ({
    label: 'Project memory',
    description: `${input.inGitRepo ? 'Checked in at' : 'Saved in'} ${fromStartDir(input.startDir, path)}`,
  }),
  import: ({ depth }, { path, deps }) => ({
    label: `${'  '.repeat(Math.max(0, depth - 1))}L ${deps.displayPath(path)}`,
    description: IMPORT_NOTE,
  }),
  other: (_kind, { path, deps }) => ({ label: deps.displayPath(path) }),
}

function fileRowText<K extends keyof FileKindPayload>(kind: FileKind<K>, ctx: FileContext): RowText {
  const render: (kind: FileKind<K>, ctx: FileContext) => RowText = FILE_ROW_TEXT[kind.kind]
  return render(kind, ctx)
}

/** How many `@`-imports separate a file from the file the loader started at. */
function importDepth(file: MemoryFileInfo, byPath: ReadonlyMap<string, MemoryFileInfo>): number {
  const visited = new Set<string>()
  let depth = 0
  let parent = file.parent
  while (parent !== undefined && !visited.has(parent)) {
    visited.add(parent)
    depth++
    parent = byPath.get(parent)?.parent
  }
  return depth
}

export function classifyFile(
  file: MemoryFileInfo,
  anchors: { userFilePath: string; projectFilePath: string },
  byPath: ReadonlyMap<string, MemoryFileInfo>,
): FileKind {
  if (file.path === anchors.userFilePath) return { kind: 'user' }
  if (file.path === anchors.projectFilePath) return { kind: 'project' }
  if (file.parent !== undefined) return { kind: 'import', depth: importDepth(file, byPath) }
  return { kind: 'other' }
}

/** The two memory indexes have their own folder rows, so they are not listed as files. */
function isListedFile(file: MemoryFileInfo): boolean {
  return file.type !== 'AutoMem' && file.type !== 'TeamMem'
}

function withCount(title: string, count: number | undefined): string {
  return count === undefined ? title : `${title} · ${count}`
}

function folderRows(input: SelectorRowInput, deps: SelectorRowDeps): SelectorRow[] {
  const rows: SelectorRow[] = [
    {
      label: withCount(PRIVATE_TITLE, input.counts?.private),
      value: encodeBrowseValue({ dir: input.privateDir, title: PRIVATE_TITLE, isTeamDir: false }),
      description: `Saved in ${deps.displayPath(input.privateDir)}`,
    },
  ]
  if (input.teamDir !== null) {
    rows.push({
      label: withCount(TEAM_TITLE, input.counts?.team),
      value: encodeBrowseValue({ dir: input.teamDir, title: TEAM_TITLE, isTeamDir: true }),
      description: `Shared with the team, git-tracked at ${deps.displayPath(input.teamDir)}`,
    })
  }
  rows.push({ label: 'Tidy memories', value: TIDY_VALUE, description: TIDY_NOTE })

  for (const agent of input.agents) {
    if (agent.memory === undefined) continue
    const title = `${agent.agentType} agent memory`
    rows.push({
      label: title,
      emphasis: agent.agentType,
      value: encodeBrowseValue({ dir: deps.agentMemoryDir(agent.agentType, agent.memory), title, isTeamDir: false }),
      description: `${agent.memory} scope`,
    })
  }
  return rows
}

/** Every row of the picker, in display order. */
export function buildSelectorRows(input: SelectorRowInput, deps: SelectorRowDeps): SelectorRow[] {
  const projectFilePath = getProjectMemoryPathForSelector(input.loadedFiles, input.startDir)
  const anchors = { userFilePath: input.userFilePath, projectFilePath }
  const files = input.loadedFiles.filter(isListedFile)
  const byPath = new Map(files.map(file => [file.path, file]))

  const rows: SelectorRow[] = files.map(file => ({
    ...fileRowText(classifyFile(file, anchors, byPath), { path: file.path, input, deps }),
    value: file.path,
  }))

  // The two files a user edits most get a row even before they exist; the
  // caller creates the file when it is chosen.
  const missing: Array<[string, FileKind]> = [
    [input.userFilePath, { kind: 'user' }],
    [projectFilePath, { kind: 'project' }],
  ]
  for (const [path, kind] of missing) {
    if (byPath.has(path)) continue
    rows.push({ ...fileRowText(kind, { path, input, deps }), value: path })
  }

  return input.autoMemoryOn ? [...rows, ...folderRows(input, deps)] : rows
}
