// Reconstructed from its use sites — the original module was not carried into
// this fork. `Tip`'s fields are the four keys every entry of `externalTips` in
// `tipRegistry.ts` sets; `TipContext` is the object REPL.tsx passes to
// `getTipToShowOnSpinner`.
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { ThemeName } from '../../utils/theme.js'

/** What the registry gets to decide whether a tip is worth showing right now. */
export type TipContext = {
  /** The active theme's NAME — `useTheme()` yields a `ThemeName`, and that is
   * what `color()` and `getTheme()` take. */
  theme: ThemeName
  /** Files read so far this session, used for file-type-relevant tips. */
  readFileState: FileStateCache
  /** Base commands seen in Bash tool calls this session. */
  bashTools: Set<string>
}

export type Tip = {
  /** Stable key used by `tipHistory` to track when this tip was last shown. */
  id: string
  /** Rendered lazily so a tip can format shortcuts against the live theme. */
  content: (args: { theme: ThemeName }) => Promise<string>
  /** Sessions that must pass before this tip may be shown again. */
  cooldownSessions: number
  /**
   * Required: `getRelevantTips` calls it on every registry entry without a
   * guard. An always-eligible tip returns `true`.
   */
  isRelevant: (context?: TipContext) => Promise<boolean>
}
