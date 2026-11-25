import { feature } from 'bun:bundle'
import z from 'zod/v4'
import { PAUSE_ICON } from 'src/shared/constants/figures.js'
import { hasNerdFontGlyphs } from 'src/terminal/terminalFont.js'
// Types extracted to src/shared/types/permissions.ts to break import cycles
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from 'src/shared/types/permissions.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'

// Re-export for backwards compatibility
export {
  EXTERNAL_PERMISSION_MODES,
  PERMISSION_MODES,
  type ExternalPermissionMode,
  type PermissionMode,
}

export const permissionModeSchema = lazySchema(() => z.enum(PERMISSION_MODES))
export const externalPermissionModeSchema = lazySchema(() =>
  z.enum(EXTERNAL_PERMISSION_MODES),
)

type ModeColorKey =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type PermissionModeConfig = {
  title: string
  shortTitle: string
  symbol: string
  color: ModeColorKey
  external: ExternalPermissionMode
}

const PERMISSION_MODE_CONFIG: Partial<
  Record<PermissionMode, PermissionModeConfig>
> = {
  default: {
    title: 'Default',
    shortTitle: 'Default',
    symbol: '',
    color: 'text',
    external: 'default',
  },
  plan: {
    title: 'Plan Mode',
    shortTitle: 'Plan',
    symbol: PAUSE_ICON,
    color: 'planMode',
    external: 'plan',
  },
  acceptEdits: {
    title: 'Accept edits',
    shortTitle: 'Accept',
    symbol: '⏵⏵',
    color: 'autoAccept',
    external: 'acceptEdits',
  },
  bypassPermissions: {
    title: 'Bypass Permissions',
    shortTitle: 'Bypass',
    symbol: '⏵⏵',
    color: 'error',
    external: 'bypassPermissions',
  },
  dontAsk: {
    title: "Don't Ask",
    shortTitle: 'DontAsk',
    symbol: '⏵⏵',
    color: 'error',
    external: 'dontAsk',
  },
  ...(feature('TRANSCRIPT_CLASSIFIER')
    ? {
        auto: {
          title: 'Auto mode',
          shortTitle: 'Auto',
          symbol: '⏵⏵',
          color: 'warning' as ModeColorKey,
          external: 'default' as ExternalPermissionMode,
        },
      }
    : {}),
}

/**
 * Type guard to check if a PermissionMode is an ExternalPermissionMode.
 * auto is internal-only and excluded from external modes.
 */
export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  return mode !== 'auto'
}

function getModeConfig(mode: PermissionMode): PermissionModeConfig {
  return PERMISSION_MODE_CONFIG[mode] ?? PERMISSION_MODE_CONFIG.default!
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return getModeConfig(mode).external
}

export function permissionModeFromString(str: string): PermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(str)
    ? (str as PermissionMode)
    : 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return getModeConfig(mode).title
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === 'default' || mode === undefined
}

// The footer's mode icon on a Nerd Font terminal (nf-md-*; footerGroupIcons.ts
// has why not nf-fa-*). Plan and accept-edits reuse the tool-row icons of
// the plan and Edit tools; the two modes that skip prompts share a shield-off.
const NERD_MODE_SYMBOLS: Partial<Record<PermissionMode, string>> = {
  plan: '\u{f0982}', // nf-md-map_outline
  acceptEdits: '\u{f0dc9}', // nf-md-file_document_edit_outline
  bypassPermissions: '\u{f099c}', // nf-md-shield_off_outline
  dontAsk: '\u{f099c}',
  auto: '\u{f0068}', // nf-md-auto_fix
}

/**
 * The mode's symbol for the footer. A mode without one (default) stays
 * without one; on a Nerd Font terminal the rest swap ⏵⏵/⏸ for an icon each.
 */
export function permissionModeSymbol(mode: PermissionMode): string {
  const symbol = getModeConfig(mode).symbol
  if (symbol === '' || !hasNerdFontGlyphs()) return symbol
  return NERD_MODE_SYMBOLS[mode] ?? symbol
}

export function getModeColor(mode: PermissionMode): ModeColorKey {
  return getModeConfig(mode).color
}
