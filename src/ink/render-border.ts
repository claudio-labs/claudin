import chalk from 'chalk'
import cliBoxes, { type Boxes, type BoxStyle } from 'cli-boxes'
import { applyColor } from './colorize.js'
import type { DOMNode } from './dom.js'
import type Output from './output.js'
import { stringWidth } from './stringWidth.js'
import type { Color } from './styles.js'

export type BorderTextOptions = {
  content: string // Pre-rendered string with ANSI color codes
  position: 'top' | 'bottom'
  align: 'start' | 'end' | 'center'
  offset?: number // Only used with 'start' or 'end' alignment. Number of characters from the edge.
}

export const CUSTOM_BORDER_STYLES = {
  dashed: {
    top: '╌',
    left: '╎',
    right: '╎',
    bottom: '╌',
    // there aren't any line-drawing characters for dashes unfortunately
    topLeft: ' ',
    topRight: ' ',
    bottomLeft: ' ',
    bottomRight: ' ',
  },
} as const

export type BorderStyle =
  | keyof Boxes
  | keyof typeof CUSTOM_BORDER_STYLES
  | BoxStyle

function embedTextInBorder(
  borderLine: string,
  text: string,
  align: 'start' | 'end' | 'center',
  offset: number = 0,
  borderChar: string,
): [before: string, text: string, after: string] {
  const textLength = stringWidth(text)
  const borderLength = borderLine.length

  if (textLength >= borderLength - 2) {
    return ['', text.substring(0, borderLength), '']
  }

  let position: number
  if (align === 'center') {
    position = Math.floor((borderLength - textLength) / 2)
  } else if (align === 'start') {
    position = offset + 1 // +1 to account for corner character
  } else {
    // align === 'end'
    position = borderLength - textLength - offset - 1 // -1 for corner character
  }

  // Ensure position is valid
  position = Math.max(1, Math.min(position, borderLength - textLength - 1))

  const before = borderLine.substring(0, 1) + borderChar.repeat(position - 1)
  const after =
    borderChar.repeat(borderLength - position - textLength - 1) +
    borderLine.substring(borderLength - 1)

  return [before, text, after]
}

function styleBorderLine(
  line: string,
  color: Color | undefined,
  dim: boolean | undefined,
): string {
  let styled = applyColor(line, color)
  if (dim) {
    styled = chalk.dim(styled)
  }
  return styled
}

/**
 * Embed multiple text segments into a border line, then style the remaining
 * border characters. Earlier entries win on overlap — later segments that
 * would collide with a placed segment are skipped silently.
 */
function buildBorderWithTexts(
  borderLine: string,
  items: readonly BorderTextOptions[],
  borderChar: string,
  borderColor: Color | undefined,
  dimBorderColor: boolean | undefined,
): string {
  if (items.length === 0) {
    return styleBorderLine(borderLine, borderColor, dimBorderColor)
  }

  type Placement = { start: number; end: number; content: string }
  const placements: Placement[] = []
  for (const item of items) {
    const len = stringWidth(item.content)
    if (len >= borderLine.length - 2) {
      // Too wide to fit alongside anything — fall back to single-segment behaviour.
      const [before, text, after] = embedTextInBorder(
        borderLine,
        item.content,
        item.align,
        item.offset,
        borderChar,
      )
      return (
        styleBorderLine(before, borderColor, dimBorderColor) +
        text +
        styleBorderLine(after, borderColor, dimBorderColor)
      )
    }
    let start: number
    if (item.align === 'center') {
      start = Math.floor((borderLine.length - len) / 2)
    } else if (item.align === 'start') {
      start = (item.offset ?? 0) + 1
    } else {
      start = borderLine.length - len - (item.offset ?? 0) - 1
    }
    start = Math.max(1, Math.min(start, borderLine.length - len - 1))
    const end = start + len

    // Skip if this placement overlaps an existing one.
    const overlaps = placements.some(
      p => !(end <= p.start || start >= p.end),
    )
    if (overlaps) continue

    placements.push({ start, end, content: item.content })
  }

  if (placements.length === 0) {
    return styleBorderLine(borderLine, borderColor, dimBorderColor)
  }

  placements.sort((a, b) => a.start - b.start)

  let out = ''
  let cursor = 0
  for (const p of placements) {
    if (p.start > cursor) {
      out += styleBorderLine(
        borderLine.substring(cursor, p.start),
        borderColor,
        dimBorderColor,
      )
    }
    out += p.content
    cursor = p.end
  }
  if (cursor < borderLine.length) {
    out += styleBorderLine(
      borderLine.substring(cursor),
      borderColor,
      dimBorderColor,
    )
  }
  return out
}

function getBorderTextsForPosition(
  borderText: BorderTextOptions | readonly BorderTextOptions[] | undefined,
  position: 'top' | 'bottom',
): readonly BorderTextOptions[] {
  if (!borderText) return []
  const arr = Array.isArray(borderText) ? borderText : [borderText as BorderTextOptions]
  return arr.filter(t => t.position === position)
}

const renderBorder = (
  x: number,
  y: number,
  node: DOMNode,
  output: Output,
): void => {
  if (node.style.borderStyle) {
    const width = Math.floor(node.yogaNode!.getComputedWidth())
    const height = Math.floor(node.yogaNode!.getComputedHeight())
    const box =
      typeof node.style.borderStyle === 'string'
        ? (CUSTOM_BORDER_STYLES[
            node.style.borderStyle as keyof typeof CUSTOM_BORDER_STYLES
          ] ?? cliBoxes[node.style.borderStyle as keyof Boxes])
        : node.style.borderStyle

    const topBorderColor = node.style.borderTopColor ?? node.style.borderColor
    const bottomBorderColor =
      node.style.borderBottomColor ?? node.style.borderColor
    const leftBorderColor = node.style.borderLeftColor ?? node.style.borderColor
    const rightBorderColor =
      node.style.borderRightColor ?? node.style.borderColor

    const dimTopBorderColor =
      node.style.borderTopDimColor ?? node.style.borderDimColor

    const dimBottomBorderColor =
      node.style.borderBottomDimColor ?? node.style.borderDimColor

    const dimLeftBorderColor =
      node.style.borderLeftDimColor ?? node.style.borderDimColor

    const dimRightBorderColor =
      node.style.borderRightDimColor ?? node.style.borderDimColor

    const showTopBorder = node.style.borderTop !== false
    const showBottomBorder = node.style.borderBottom !== false
    const showLeftBorder = node.style.borderLeft !== false
    const showRightBorder = node.style.borderRight !== false

    const contentWidth = Math.max(
      0,
      width - (showLeftBorder ? 1 : 0) - (showRightBorder ? 1 : 0),
    )

    const topBorderLine = showTopBorder
      ? (showLeftBorder ? box.topLeft : '') +
        box.top.repeat(contentWidth) +
        (showRightBorder ? box.topRight : '')
      : ''

    // Handle text in top border (supports single value or array)
    let topBorder: string | undefined
    if (showTopBorder) {
      const topTexts = getBorderTextsForPosition(node.style.borderText, 'top')
      topBorder = buildBorderWithTexts(
        topBorderLine,
        topTexts,
        box.top,
        topBorderColor,
        dimTopBorderColor,
      )
    }

    let verticalBorderHeight = height

    if (showTopBorder) {
      verticalBorderHeight -= 1
    }

    if (showBottomBorder) {
      verticalBorderHeight -= 1
    }

    verticalBorderHeight = Math.max(0, verticalBorderHeight)

    let leftBorder = (applyColor(box.left, leftBorderColor) + '\n').repeat(
      verticalBorderHeight,
    )

    if (dimLeftBorderColor) {
      leftBorder = chalk.dim(leftBorder)
    }

    let rightBorder = (applyColor(box.right, rightBorderColor) + '\n').repeat(
      verticalBorderHeight,
    )

    if (dimRightBorderColor) {
      rightBorder = chalk.dim(rightBorder)
    }

    const bottomBorderLine = showBottomBorder
      ? (showLeftBorder ? box.bottomLeft : '') +
        box.bottom.repeat(contentWidth) +
        (showRightBorder ? box.bottomRight : '')
      : ''

    // Handle text in bottom border (supports single value or array)
    let bottomBorder: string | undefined
    if (showBottomBorder) {
      const bottomTexts = getBorderTextsForPosition(node.style.borderText, 'bottom')
      bottomBorder = buildBorderWithTexts(
        bottomBorderLine,
        bottomTexts,
        box.bottom,
        bottomBorderColor,
        dimBottomBorderColor,
      )
    }

    const offsetY = showTopBorder ? 1 : 0

    if (topBorder) {
      output.write(x, y, topBorder)
    }

    if (showLeftBorder) {
      output.write(x, y + offsetY, leftBorder)
    }

    if (showRightBorder) {
      output.write(x + width - 1, y + offsetY, rightBorder)
    }

    if (bottomBorder) {
      output.write(x, y + height - 1, bottomBorder)
    }
  }
}

export default renderBorder
