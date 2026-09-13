import type { DOMElement } from 'src/terminal/ink/dom.js'

type Output = {
  /**
   * Element width.
   */
  width: number

  /**
   * Element height.
   */
  height: number
}

/**
 * Measure the dimensions of a particular `<Box>` element.
 */
const measureElement = (node: DOMElement): Output => ({
  width: node.yogaNode?.getComputedWidth() ?? 0,
  height: node.yogaNode?.getComputedHeight() ?? 0,
})

export default measureElement

export type AbsoluteRect = Output & {
  /** Distance from the top of the screen, in rows. */
  top: number
  /** Distance from the left of the screen, in columns. */
  left: number
}

/**
 * Where a `<Box>` actually sits on screen. Yoga reports each node's position
 * relative to its parent, so this walks the `parentNode` chain and sums —
 * exactly what the renderer does as it descends
 * (`render-node-to-output.ts` carries an accumulated x/y down the tree).
 *
 * Only valid for a node with no absolutely-positioned or scrolled ancestor:
 * an `overflow: scroll` parent offsets its children by `scrollTop`, which is
 * not part of the layout and so is not summed here. That holds for the
 * fullscreen side panel, which is a plain flex child — mind it before reusing
 * this inside the transcript's ScrollBox.
 */
export function measureAbsoluteRect(node: DOMElement): AbsoluteRect {
  let top = 0
  let left = 0
  let current: DOMElement | undefined = node
  while (current) {
    top += current.yogaNode?.getComputedTop() ?? 0
    left += current.yogaNode?.getComputedLeft() ?? 0
    current = current.parentNode
  }
  return { top, left, ...measureElement(node) }
}
