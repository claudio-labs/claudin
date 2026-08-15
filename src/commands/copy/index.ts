/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import type { Command } from 'src/commands/commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    "Copy Claudin's last response to clipboard (or /copy N for the Nth-latest)",
  load: () => import('src/commands/copy/copy.js'),
} satisfies Command

export default copy
