import { join, normalize, sep } from 'path'
import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { getScratchpadDir, isScratchpadEnabled } from 'src/agent/scratchpad.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memory/memdir/paths.js'
import { getSessionMemoryDir } from 'src/memory/session/paths.js'
import { pathInWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'
import { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { SETTING_SOURCES } from 'src/platform/settings/constants.js'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { expandPath } from 'src/shared/fs/path.js'
import { getBundledSkillsRoot } from 'src/skills/bundledSkillsRoot.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'

/**
 * If filePath is inside a .claudin/skills/{name}/ directory (project or global),
 * return the skill name and a session-allow pattern scoped to just that skill.
 * Used to offer a narrower "allow edits to this skill only" option in the
 * permission dialog and SDK suggestions, so iterating on one skill doesn't
 * require granting session access to all of .claudin/ (settings.json, hooks/, etc.).
 */
export function getClaudeSkillScope(
  filePath: string,
): { skillName: string; pattern: string } | null {
  const absolutePath = expandPath(filePath)
  const absolutePathLower = normalizeCaseForComparison(absolutePath)

  const bases = [
    {
      dir: expandPath(join(getOriginalCwd(), '.claudin', 'skills')),
      prefix: '/.claudin/skills/',
    },
    {
      dir: expandPath(join(getClaudinConfigHomeDir(), 'skills')),
      prefix: '~/.claudin/skills/',
    },
  ]

  for (const { dir, prefix } of bases) {
    const dirLower = normalizeCaseForComparison(dir)
    // Try both path separators (Windows paths may not be normalized to /)
    for (const s of [sep, '/']) {
      if (absolutePathLower.startsWith(dirLower + s.toLowerCase())) {
        // Match on lowercase, but slice the ORIGINAL path so the skill name
        // preserves case (pattern matching downstream is case-sensitive)
        const rest = absolutePath.slice(dir.length + s.length)
        const slash = rest.indexOf('/')
        const bslash = sep === '\\' ? rest.indexOf('\\') : -1
        const cut =
          slash === -1
            ? bslash
            : bslash === -1
              ? slash
              : Math.min(slash, bslash)
        // Require a separator: file must be INSIDE the skill dir, not a
        // file directly under skills/ (no skill scope for that)
        if (cut <= 0) return null
        const skillName = rest.slice(0, cut)
        // Reject traversal and empty. Use includes('..') not === '..' to
        // match step 1.6's ruleContent.includes('..') guard: a skillName like
        // 'v2..beta' would otherwise produce a suggestion step 1.7 emits but
        // step 1.6 always rejects (dead suggestion, infinite re-prompt).
        if (!skillName || skillName === '.' || skillName.includes('..')) {
          return null
        }
        // Reject glob metacharacters. skillName is interpolated into a
        // gitignore pattern consumed by ignore().add() in matchingRuleForInput
        // at step 1.6. A directory literally named '*' (valid on POSIX) would
        // produce '/.claude/skills/*/**' which matches ALL skills. Return null
        // to fall through to generateSuggestions() instead.
        if (/[*?[\]]/.test(skillName)) return null
        return { skillName, pattern: prefix + skillName + '/**' }
      }
    }
  }

  return null
}

function getSettingsPaths(): string[] {
  return SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter(path => path !== undefined)
}

export function isClaudeSettingsPath(filePath: string): boolean {
  // SECURITY: Normalize path structure first to prevent bypass via redundant ./
  // sequences like `./.claude/./settings.json` which would evade the endsWith() check
  const expandedPath = expandPath(filePath)

  // Normalize for case-insensitive comparison to prevent bypassing security
  // with paths like .cLauDe/Settings.locaL.json
  const normalizedPath = normalizeCaseForComparison(expandedPath)

  // Use platform separator so endsWith checks work on both Unix (/) and Windows (\)
  if (
    normalizedPath.endsWith(`${sep}.claudin${sep}settings.json`) ||
    normalizedPath.endsWith(`${sep}.claudin${sep}settings.local.json`)
  ) {
    // Include .claudin/settings.json even for other projects
    return true
  }
  // Check for current project's settings files (including managed settings and CLI args)
  // Both paths are now absolute and normalized for consistent comparison
  return getSettingsPaths().some(
    settingsPath => normalizeCaseForComparison(settingsPath) === normalizedPath,
  )
}

// Always ask when Claude Code tries to edit its own config files
export function isClaudeConfigFilePath(filePath: string): boolean {
  if (isClaudeSettingsPath(filePath)) {
    return true
  }

  // Check if file is within .claudin/commands, .claudin/agents, or .claudin/skills directories
  // using proper path segment validation (not string matching with includes())
  // pathInWorkingPath now handles case-insensitive comparison to prevent bypasses
  const commandsDir = join(getOriginalCwd(), '.claudin', 'commands')
  const agentsDir = join(getOriginalCwd(), '.claudin', 'agents')
  const skillsDir = join(getOriginalCwd(), '.claudin', 'skills')

  return (
    pathInWorkingPath(filePath, commandsDir) ||
    pathInWorkingPath(filePath, agentsDir) ||
    pathInWorkingPath(filePath, skillsDir)
  )
}

// Check if file is a plan file for the current session.
//
// Plan files live DIRECTLY inside the session plans directory:
//   Main plan file:  {plansDir}/{planSlug}.md
//   Agent plan file: {plansDir}/{planSlug}-agent-{agentId}.md
//
// We match any *.md directly in that directory rather than requiring the path
// to start with the exact current {planSlug}. The slug is regenerable and
// cached per session (getPlanSlug()); if it drifts from the slug embedded in
// the path the model was told (e.g. a slug-cache miss, resume without a slug
// marker), an exact-slug match would silently fail — and because plan mode
// forbids every other write, the model gets locked out of its own plan file
// with a confusing "Only the plan file may be edited" denial. Matching the
// whole directory removes that brittleness.
//
// SECURITY: the plans directory itself is symlink-escape validated and created
// 0700 in getPlansDirectory(), so widening to the directory keeps the same
// containment guarantee. Subdirectories and path-traversal are still rejected:
// after the "{plansDir}/" prefix the remainder must be a single .md filename
// with no further path separator.
function isSessionPlanFile(absolutePath: string): boolean {
  // SECURITY: Normalize both sides to prevent traversal bypasses via .. segments
  const plansDir = normalize(getPlansDirectory())
  const normalizedPath = normalize(absolutePath)
  const prefix = plansDir + sep
  if (!normalizedPath.startsWith(prefix) || !normalizedPath.endsWith('.md')) {
    return false
  }
  const basename = normalizedPath.slice(prefix.length)
  return basename.length > 0 && !basename.includes(sep)
}

// Check if file is within the session memory directory
function isSessionMemoryPath(absolutePath: string): boolean {
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getSessionMemoryDir())
}

/**
 * Check if file is within the current project's directory.
 * Path format: ~/.claude/projects/{sanitized-cwd}/...
 */
function isProjectDirPath(absolutePath: string): boolean {
  const projectDir = getProjectDir(getCwd())
  // SECURITY: Normalize to prevent path traversal bypasses via .. segments
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === projectDir || normalizedPath.startsWith(projectDir + sep)
  )
}

// Check if file is within the scratchpad directory
function isScratchpadPath(absolutePath: string): boolean {
  if (!isScratchpadEnabled()) {
    return false
  }
  const scratchpadDir = getScratchpadDir()
  // SECURITY: Normalize the path to resolve .. segments before checking
  // This prevents path traversal bypasses like:
  //   echo "malicious" > /tmp/claude-0/proj/session/scratchpad/../../../etc/passwd
  // Without normalization, the path would pass the startsWith check but write to /etc/passwd
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === scratchpadDir ||
    normalizedPath.startsWith(scratchpadDir + sep)
  )
}

/**
 * Check if a path is an internal path that can be edited without permission.
 * Returns a PermissionResult - either 'allow' if matched, or 'passthrough' to continue checking.
 */
export function checkEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // SECURITY: Normalize path to prevent traversal bypasses via .. segments
  // This is defense-in-depth; individual helper functions also normalize
  const normalizedPath = normalize(absolutePath)

  // Plan files for current session
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for writing',
      },
    }
  }

  // Scratchpad directory for current session
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for writing',
      },
    }
  }

  // Agent memory directory (for self-improving agents)
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for writing',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  // This pre-safety-check carve-out exists because the default path is under
  // ~/.claude/, which is in DANGEROUS_DIRECTORIES. The CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  // override is an arbitrary caller-designated directory with no such conflict,
  // so it gets NO special permission treatment here — writes go through normal
  // permission flow (step 5 → ask). SDK callers who want silent memory should
  // pass an allow rule for the override path.
  if (!hasAutoMemPathOverride() && isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for writing',
      },
    }
  }

  // .claudin/launch.json — desktop preview config (dev server command + port).
  // The desktop's preview_start MCP tool instructs Claude to create/update
  // this file as part of the preview workflow. Without this carve-out the
  // .claudin/ DANGEROUS_DIRECTORIES check prompts for it, which in SDK mode
  // cascades: user clicks "Always allow" → setMode:acceptEdits suggestion
  // applied → silent downgrade from auto mode. Matches the project-level
  // .claudin/ only (not ~/.claudin/) since launch.json is per-project.
  if (
    normalizeCaseForComparison(normalizedPath) ===
    normalizeCaseForComparison(join(getOriginalCwd(), '.claudin', 'launch.json'))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Preview launch config is allowed for writing',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}

/**
 * Check if a path is an internal path that can be read without permission.
 * Returns a PermissionResult - either 'allow' if matched, or 'passthrough' to continue checking.
 */
export function checkReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // SECURITY: Normalize path to prevent traversal bypasses via .. segments
  // This is defense-in-depth; individual helper functions also normalize
  const normalizedPath = normalize(absolutePath)

  // Session memory directory
  if (isSessionMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Session memory files are allowed for reading',
      },
    }
  }

  // Project directory (for reading past session memories)
  // Path format: ~/.claude/projects/{sanitized-cwd}/...
  if (isProjectDirPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project directory files are allowed for reading',
      },
    }
  }

  // Plan files for current session
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for reading',
      },
    }
  }

  // Tool results directory (persisted large outputs)
  // Use path separator suffix to prevent path traversal (e.g., tool-results-evil/)
  const toolResultsDir = getToolResultsDir()
  const toolResultsDirWithSep = toolResultsDir.endsWith(sep)
    ? toolResultsDir
    : toolResultsDir + sep
  if (
    normalizedPath === toolResultsDir ||
    normalizedPath.startsWith(toolResultsDirWithSep)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Tool result files are allowed for reading',
      },
    }
  }

  // Scratchpad directory for current session
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for reading',
      },
    }
  }

  // Project temp directory (/tmp/claude/{sanitized-cwd}/)
  // Intentionally allows reading files from all sessions in this project, not just the current session.
  // This enables cross-session file access within the same project's temp space.
  const projectTempDir = getProjectTempDir()
  if (normalizedPath.startsWith(projectTempDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project temp directory files are allowed for reading',
      },
    }
  }

  // Agent memory directory (for self-improving agents)
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for reading',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  if (isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for reading',
      },
    }
  }

  // Tasks directory (~/.claude/tasks/) for swarm task coordination
  const tasksDir = join(getClaudinConfigHomeDir(), 'tasks') + sep
  if (
    normalizedPath === tasksDir.slice(0, -1) ||
    normalizedPath.startsWith(tasksDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Task files are allowed for reading',
      },
    }
  }

  // Teams directory (~/.claude/teams/) for swarm coordination
  const teamsReadDir = join(getClaudinConfigHomeDir(), 'teams') + sep
  if (
    normalizedPath === teamsReadDir.slice(0, -1) ||
    normalizedPath.startsWith(teamsReadDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Team files are allowed for reading',
      },
    }
  }

  // Bundled skill reference files extracted on first invocation.
  // SECURITY: See getBundledSkillsRoot() — the per-process nonce in the path
  // is the load-bearing defense; uid/VERSION alone are public knowledge and
  // squattable. We always write-before-read on invocation, so content under
  // this subtree is harness-controlled.
  const bundledSkillsRoot = getBundledSkillsRoot() + sep
  if (normalizedPath.startsWith(bundledSkillsRoot)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Bundled skill reference files are allowed for reading',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
