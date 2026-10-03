import ignore from 'ignore'
import { dirname, isAbsolute, join, relative, sep } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import {
  getManagedClaudeRulesDir,
  getUserClaudeRulesDir,
} from 'src/platform/config/config.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import type { MemoryType } from 'src/memory/memdir/types.js'
import { getProjectInstructionFilePath } from 'src/memory/instructions/projectInstructions.js'
import { isSettingSourceEnabled } from 'src/platform/settings/constants.js'
import {
  isScopedRule,
  loadRulesDirectory,
  processMdRules,
  processMemoryFile,
} from 'src/memory/instructions/claudemd/processing.js'
import type { MemoryFileInfo } from 'src/memory/instructions/claudemd/types.js'

const PARENT_SEGMENT = '..'

/**
 * Whether a rule's `paths:` patterns cover `targetPath`, with `.gitignore`
 * semantics, relative to `anchor`. An absolute target is made relative to the
 * anchor; a relative one is taken as written. A target outside the anchor, or
 * the anchor itself, matches nothing.
 */
export function ruleGlobsMatch(globs: readonly string[], targetPath: string, anchor: string): boolean {
  const fromAnchor = isAbsolute(targetPath) ? relative(anchor, targetPath) : targetPath
  if (fromAnchor === '' || isAbsolute(fromAnchor)) return false
  if (fromAnchor === PARENT_SEGMENT || fromAnchor.startsWith(PARENT_SEGMENT + sep)) return false
  return ignore().add([...globs]).ignores(fromAnchor.split(sep).join('/'))
}

/** Project globs are relative to the directory holding `.claudin`; managed and user ones to the cwd. */
function globAnchor(rulesDir: string, type: MemoryType): string {
  return type === 'Project' ? dirname(dirname(rulesDir)) : getOriginalCwd()
}

function matchingScopedRules(files: MemoryFileInfo[], targetPath: string, anchor: string): MemoryFileInfo[] {
  return files.filter(file => file.globs !== undefined && ruleGlobsMatch(file.globs, targetPath, anchor))
}

export async function getManagedAndUserConditionalRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const managed = await processConditionedMdRules(targetPath, getManagedClaudeRulesDir(), 'Managed', processedPaths, false)
  if (!isSettingSourceEnabled('userSettings')) return managed
  const user = await processConditionedMdRules(targetPath, getUserClaudeRulesDir(), 'User', processedPaths, true)
  return [...managed, ...user]
}

export async function getMemoryFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const loaded: MemoryFileInfo[] = []
  if (isSettingSourceEnabled('projectSettings')) {
    const rootFile = getProjectInstructionFilePath(dir, path => getFsImplementation().existsSync(path))
    for (const path of [rootFile, join(dir, '.claudin', 'CLAUDE.md')]) {
      loaded.push(...(await processMemoryFile(path, 'Project', processedPaths, false)))
    }
  }
  if (isSettingSourceEnabled('localSettings')) {
    loaded.push(...(await processMemoryFile(join(dir, 'CLAUDE.local.md'), 'Local', processedPaths, false)))
  }

  // One read of the rules serves both halves: a second pass would find every
  // rule file already seen.
  const rulesDir = join(dir, '.claudin', 'rules')
  const rules = await loadRulesDirectory({ rulesDir, type: 'Project', processedPaths, includeExternal: false })
  loaded.push(...rules.filter(rule => !isScopedRule(rule)))
  loaded.push(...matchingScopedRules(rules, targetPath, globAnchor(rulesDir, 'Project')))
  return loaded
}

export async function getConditionalRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  return processConditionedMdRules(targetPath, join(dir, '.claudin', 'rules'), 'Project', processedPaths, false)
}

export async function processConditionedMdRules(
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<MemoryFileInfo[]> {
  const scoped = await processMdRules({ rulesDir, type, processedPaths, includeExternal, conditionalRule: true })
  return matchingScopedRules(scoped, targetPath, globAnchor(rulesDir, type))
}
