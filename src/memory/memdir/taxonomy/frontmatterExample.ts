import { MEMORY_TYPES } from 'src/memory/memdir/taxonomy/memoryKinds.js'

// `type` stays a top-level key: memoryScan.ts reads it there, and a nested
// shape would leave every new memory silently untyped.
export const MEMORY_FRONTMATTER_EXAMPLE: readonly string[] = [
  '```markdown',
  '---',
  'name: {{kebab-case slug, e.g. prefers-squash-merges}}',
  'description: {{one specific line, used later to judge relevance}}',
  `type: {{${MEMORY_TYPES.join(' | ')}}}`,
  '---',
  '',
  '{{The fact. For feedback and project, follow it with a **Why:** line and a **How to apply:** line. Link related memories as [[their-name]].}}',
  '```',
]
