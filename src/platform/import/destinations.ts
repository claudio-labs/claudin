/**
 * Where an imported artifact lands.
 *
 * Every path here is derived from the injected `CollectContext` rather than
 * from `getCwd()` / `homedir()`, so a test can point a whole import at a temp
 * directory without mocking a module.
 */
import { join } from 'path'

import { fileSuffixForOauthConfig } from 'src/shared/constants/oauth.js'
import type { CollectContext, ImportScope } from 'src/platform/import/types.js'

export function claudinRoot(ctx: CollectContext, scope: ImportScope): string {
  return scope === 'user' ? ctx.claudinHomeDir : join(ctx.cwd, '.claudin')
}

export function commandsDir(ctx: CollectContext, scope: ImportScope): string {
  return join(claudinRoot(ctx, scope), 'commands')
}

export function agentsDir(ctx: CollectContext, scope: ImportScope): string {
  return join(claudinRoot(ctx, scope), 'agents')
}

export function rulesDir(ctx: CollectContext, scope: ImportScope): string {
  return join(claudinRoot(ctx, scope), 'rules')
}

export function skillsDir(ctx: CollectContext, scope: ImportScope): string {
  return join(claudinRoot(ctx, scope), 'skills')
}

/**
 * User memory is `~/.claudin/CLAUDE.md` and project memory prefers `AGENTS.md`
 * at the project root — the loader's own order, documented at the top of
 * `src/memory/instructions/claudemd.ts`. Note the asymmetry: the user-level file
 * is NOT called AGENTS.md, so a `~/.codex/AGENTS.md` still lands as CLAUDE.md.
 */
export function instructionsPath(
  ctx: CollectContext,
  scope: ImportScope,
): string {
  return scope === 'user'
    ? join(ctx.claudinHomeDir, 'CLAUDE.md')
    : join(ctx.cwd, 'AGENTS.md')
}

/**
 * The files a project-scope instruction import must not shadow. If either
 * exists we skip and report rather than writing a second source of truth.
 */
export function existingProjectInstructionCandidates(
  ctx: CollectContext,
): string[] {
  return [join(ctx.cwd, 'AGENTS.md'), join(ctx.cwd, 'CLAUDE.md')]
}

export function settingsPath(ctx: CollectContext, scope: ImportScope): string {
  return join(claudinRoot(ctx, scope), 'settings.json')
}

export function globalConfigPath(ctx: CollectContext): string {
  return join(ctx.claudinHomeDir, `config${fileSuffixForOauthConfig()}.json`)
}
