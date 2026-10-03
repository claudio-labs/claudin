import type { PermissionRuleSource } from 'src/permissions/PermissionRule.js'
import { posixPathToWindowsPath } from 'src/shared/fs/windowsPaths.js'
import { anchorDirOfSource, type RuleAnchors } from 'src/permissions/filePermissions/fileRules/anchors.js'

/** A rule's pattern split into the directory it is matched from and the rest. */
export type AnchoredPattern = {
  /** null: the current directory, looked up when the pattern is matched. */
  readonly anchor: string | null
  /** gitignore syntax, relative to the anchor. An anchored body starts with `/`. */
  readonly body: string
}

const DRIVE_AFTER_DOUBLE_SLASH = /^\/\/([A-Za-z])(?=\/|$)/

export function anchorPattern(
  text: string,
  source: PermissionRuleSource,
  anchors: RuleAnchors,
): AnchoredPattern {
  if (text.startsWith('//')) return fromFilesystemRoot(text, anchors)
  if (text.startsWith('~/')) return { anchor: anchors.homeDir, body: text.slice(1) }
  if (text.startsWith('/')) return { anchor: anchorDirOfSource(source, anchors), body: text }
  return { anchor: null, body: text.startsWith('./') ? text.slice(2) : text }
}

function fromFilesystemRoot(text: string, anchors: RuleAnchors): AnchoredPattern {
  const drive = anchors.windows ? DRIVE_AFTER_DOUBLE_SLASH.exec(text) : null
  if (drive) {
    const rest = text.slice(drive[0].length)
    return { anchor: posixPathToWindowsPath(`/${drive[1]}`), body: rest === '' ? '/' : rest }
  }
  return { anchor: '/', body: text.slice(1) }
}
