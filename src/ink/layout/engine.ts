import type { LayoutNode } from 'src/ink/layout/node.js'
import { createYogaLayoutNode } from 'src/ink/layout/yoga.js'

export function createLayoutNode(): LayoutNode {
  return createYogaLayoutNode()
}
