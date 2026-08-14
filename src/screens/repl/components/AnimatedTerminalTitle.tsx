// Sets the terminal tab title, with an animated prefix glyph while a query
// is running. Isolated from REPL so the 960ms animation tick re-renders only
// this leaf component (which returns null — pure side-effect) instead of the
// entire REPL tree. Before extraction, the tick was ~1 REPL render/sec for
// the duration of every turn, dragging PromptInput and friends along.
//
// Extracted from src/screens/REPL.tsx (Etapa 1, ROADMAP 11e).

import { useEffect, useState } from 'react'
import { useTerminalFocus, useTerminalTitle } from 'src/ink.js'

export const TITLE_ANIMATION_FRAMES = ['⠂', '⠐'] as const
export const TITLE_STATIC_PREFIX = '✳'
export const TITLE_ANIMATION_INTERVAL_MS = 960

export type AnimatedTerminalTitleProps = {
  isAnimating: boolean
  title: string
  /** When true, suppress the title side-effect entirely. */
  disabled: boolean
  /** When true, render the title without the leading glyph prefix. */
  noPrefix: boolean
}

export function AnimatedTerminalTitle({
  isAnimating,
  title,
  disabled,
  noPrefix,
}: AnimatedTerminalTitleProps): null {
  const terminalFocused = useTerminalFocus()
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (disabled || noPrefix || !isAnimating || !terminalFocused) {
      return
    }
    const interval = setInterval(() => {
      setFrame(f => (f + 1) % TITLE_ANIMATION_FRAMES.length)
    }, TITLE_ANIMATION_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [disabled, noPrefix, isAnimating, terminalFocused])
  const prefix = isAnimating
    ? (TITLE_ANIMATION_FRAMES[frame] ?? TITLE_STATIC_PREFIX)
    : TITLE_STATIC_PREFIX
  useTerminalTitle(disabled ? null : noPrefix ? title : `${prefix} ${title}`)
  return null
}
