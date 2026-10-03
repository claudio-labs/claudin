import { feature } from 'bun:bundle'
import z from 'zod/v4'
import { PAUSE_ICON } from 'src/shared/constants/figures.js'
import {
  EXTERNAL_PERMISSION_MODES,
  type ExternalPermissionMode,
  PERMISSION_MODES,
  type PermissionMode,
} from 'src/shared/types/permissions.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'

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

/** The theme colour a mode is drawn in. */
export type PermissionModeColor =
  | 'text'
  | 'planMode'
  | 'permission'
  | 'autoAccept'
  | 'error'
  | 'warning'

type ModeRow = {
  readonly title: string
  readonly symbol: string
  readonly color: PermissionModeColor
  /** How the mode is reported to an SDK host. */
  readonly reportedAs: ExternalPermissionMode
}

const FAST_FORWARD = '\u23f5\u23f5'

const DEFAULT_ROW: ModeRow = {
  title: 'Default',
  symbol: '',
  color: 'text',
  reportedAs: 'default',
}

const AUTO_ROW: ModeRow = {
  title: 'Auto mode',
  symbol: FAST_FORWARD,
  color: 'warning',
  reportedAs: 'default',
}

// `bubble` has no row of its own, and `auto` has one only in a classifier
// build; both fall back to the default row.
const MODE_ROWS: ReadonlyMap<PermissionMode, ModeRow> = new Map<
  PermissionMode,
  ModeRow
>([
  ['default', DEFAULT_ROW],
  ['plan', { title: 'Plan Mode', symbol: PAUSE_ICON, color: 'planMode', reportedAs: 'plan' }],
  ['acceptEdits', { title: 'Accept edits', symbol: FAST_FORWARD, color: 'autoAccept', reportedAs: 'acceptEdits' }],
  ['bypassPermissions', { title: 'Bypass Permissions', symbol: FAST_FORWARD, color: 'error', reportedAs: 'bypassPermissions' }],
  ['dontAsk', { title: "Don't Ask", symbol: FAST_FORWARD, color: 'error', reportedAs: 'dontAsk' }],
  ...(feature('TRANSCRIPT_CLASSIFIER')
    ? [['auto', AUTO_ROW] as const]
    : []),
])

function rowFor(mode: PermissionMode): ModeRow {
  return MODE_ROWS.get(mode) ?? DEFAULT_ROW
}

const EXTERNAL_MODE_SET: ReadonlySet<string> = new Set(EXTERNAL_PERMISSION_MODES)

export function isExternalPermissionMode(
  mode: PermissionMode,
): mode is ExternalPermissionMode {
  return EXTERNAL_MODE_SET.has(mode)
}

export function toExternalPermissionMode(
  mode: PermissionMode,
): ExternalPermissionMode {
  return rowFor(mode).reportedAs
}

export function permissionModeFromString(str: string): PermissionMode {
  return PERMISSION_MODES.find(mode => mode === str) ?? 'default'
}

export function permissionModeTitle(mode: PermissionMode): string {
  return rowFor(mode).title
}

export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === undefined || mode === 'default'
}

export function permissionModeSymbol(mode: PermissionMode): string {
  return rowFor(mode).symbol
}

export function getModeColor(mode: PermissionMode): PermissionModeColor {
  return rowFor(mode).color
}
