// Renders a discovery pass as a filtered outline: per file, the symbols that
// actually contain a site, in the same `start-end  signature` shape Read's
// outline uses — so the model can address a symbol here and expand it with
// `Read(file_path, symbol=…)` without translating anything.

import { rangeLabel } from 'src/tools/shared/codeOutline/renderOutline.js'
import type { FindSitesResult, RenameSite } from './findSites.js'

/** Sites listed before the tail is summarized instead of enumerated. */
const MAX_SITES_SHOWN = 200

/** Source lines are context, not content — keep them to one screen width. */
const MAX_LINE_TEXT = 100

const TOP_LEVEL_LABEL = '(top level)'

function truncate(text: string): string {
  return text.length <= MAX_LINE_TEXT
    ? text
    : `${text.slice(0, MAX_LINE_TEXT - 1)}…`
}

function pluralSites(n: number): string {
  return n === 1 ? '1 site' : `${n} sites`
}

/**
 * Groups sites by file, then by enclosing symbol, preserving discovery order
 * (path, then position).
 */
function groupByFileAndSymbol(
  sites: RenameSite[],
): Array<{
  relPath: string
  unparsed: boolean
  groups: Array<{ label: string; range: string | null; sites: RenameSite[] }>
}> {
  const files: ReturnType<typeof groupByFileAndSymbol> = []
  for (const site of sites) {
    let file = files[files.length - 1]
    if (!file || file.relPath !== site.relPath) {
      file = { relPath: site.relPath, unparsed: site.unparsed, groups: [] }
      files.push(file)
    }
    const label = site.symbol ? site.symbol.signature : TOP_LEVEL_LABEL
    const range = site.symbol ? rangeLabel(site.symbol) : null
    const group = file.groups[file.groups.length - 1]
    if (group && group.label === label && group.range === range) {
      group.sites.push(site)
    } else {
      file.groups.push({ label, range, sites: [site] })
    }
  }
  return files
}

export function renderPreview(
  result: FindSitesResult,
  params: { symbol: string; replacement: string },
): string {
  const { sites, skippedMasked, unreadable, sitesToken, files } = result

  if (sites.length === 0) {
    return `Rename preview: no code site for "${params.symbol}".${
      skippedMasked > 0
        ? ` ${skippedMasked} occurrence(s) were found only inside strings or comments.`
        : ''
    }`
  }

  const shown = sites.slice(0, MAX_SITES_SHOWN)
  const lines: string[] = [
    `Rename preview — "${params.symbol}" → "${params.replacement}": ${pluralSites(
      sites.length,
    )} across ${files.length} ${files.length === 1 ? 'file' : 'files'}.`,
    '',
  ]

  for (const file of groupByFileAndSymbol(shown)) {
    lines.push(file.unparsed ? `${file.relPath}  ~` : file.relPath)
    // A file whose language has a symbol scanner but whose site sits outside
    // every symbol still gets a header, so it reads differently from a file
    // where nothing resolved at all (mask-only languages, markdown).
    const hasSymbols = file.groups.some(g => g.range)
    for (const group of file.groups) {
      if (group.range) {
        lines.push(
          `  ${group.range}  ${group.label}    ${pluralSites(group.sites.length)}`,
        )
      } else if (hasSymbols) {
        lines.push(`  ${group.label}    ${pluralSites(group.sites.length)}`)
      }
      for (const site of group.sites) {
        const indent = group.range || hasSymbols ? '    ' : '  '
        lines.push(
          `${indent}${site.id}  :${site.line}  ${truncate(site.lineText)}`,
        )
      }
    }
  }

  if (sites.length > shown.length) {
    lines.push(`  … +${sites.length - shown.length} more sites (not listed)`)
  }

  lines.push('')
  if (skippedMasked > 0) {
    lines.push(
      `Skipped ${skippedMasked} occurrence(s) inside strings or comments.`,
    )
  }
  if (hasUnparsed(shown)) {
    lines.push(
      '`~` marks a file with no string/comment analysis — every occurrence in it is listed as-is.',
    )
  }
  for (const path of unreadable) {
    lines.push(`Could not read ${path} — it is not part of this rename.`)
  }
  lines.push(
    `sitesToken: ${sitesToken} — pass it with \`exclude\` to drop specific sites; it is only valid while the tree is unchanged.`,
  )

  return lines.join('\n')
}

function hasUnparsed(sites: RenameSite[]): boolean {
  return sites.some(s => s.unparsed)
}
