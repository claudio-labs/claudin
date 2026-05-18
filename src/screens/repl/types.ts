// Future home of shared internal types used by extracted REPL subcomponents.
//
// Etapa 0.5 of the REPL split (ROADMAP 11e) reserves this module before any
// real movement. A pre-extraction scan of `src/screens/REPL.tsx` only found
// `Props` and `Screen` declared at module scope; both are part of the
// public surface (consumed by `src/replLauncher.tsx` and by 5 type-only
// importers — `CompactSummary`, `Messages`, `MessageRow`, `useCancelRequest`,
// `useGlobalKeybindings`) and therefore stay in `REPL.tsx`. Local
// function-scoped types like `ExitState` (REPL.tsx:3640) are not exported
// elsewhere and stay where they are until their owning block is extracted.
//
// As later etapas pull dialog deps, callback signatures and state shapes
// out of REPL.tsx, they should land here first to keep child modules free
// of cyclic imports.

import type { Screen } from '../REPL.js'

// Re-export so future child modules can `import type { Screen } from
// './types.js'` instead of reaching back into the parent. Lets us flip the
// declaration's home later without churning imports.
export type { Screen }
