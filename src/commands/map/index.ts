/**
 * /map — the project's navigation map (`.claudin/rules/search-strategy.md`):
 * its status, a sync on demand, the per-project switch, and an annotation pass.
 * Implementation is lazy-loaded from map.ts to reduce startup time.
 */
import type { Command } from 'src/commands/commands.js'

const map = {
  type: 'local-jsx',
  // call() always resolves via onDone (never renders JSX), so /map works in
  // headless -p / SDK mode too.
  supportsNonInteractive: true,
  name: 'map',
  description:
    "Show or refresh this project's navigation map (.claudin/rules/search-strategy.md)",
  argumentHint: 'status | sync | on | off | annotate',
  load: () => import('src/commands/map/map.js'),
} satisfies Command

export default map
