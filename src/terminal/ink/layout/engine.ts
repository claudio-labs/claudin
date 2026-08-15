import type { LayoutNode } from 'src/terminal/ink/layout/node.js'
import { createYogaLayoutNode } from 'src/terminal/ink/layout/yoga.js'

export function createLayoutNode(): LayoutNode {
  return createYogaLayoutNode()
}
