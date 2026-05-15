import { feature } from 'bun:bundle'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useCommandQueue } from 'src/hooks/useCommandQueue.js'
import { getGlobalConfig } from 'src/utils/config.js'
import { getExampleCommandPool } from 'src/utils/exampleCommands.js'
import { isQueuedCommandEditable } from 'src/utils/messageQueueManager.js'

// Dead code elimination: conditional import for proactive mode
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('../../proactive/index.js')
    : null

type Props = {
  input: string
  submitCount: number
  viewingAgentName?: string
}

const NUM_TIMES_QUEUE_HINT_SHOWN = 3
const MAX_TEAMMATE_NAME_LENGTH = 20
const EXAMPLE_POOL_SIZE = 4
const EXAMPLE_CYCLE_MS = 6000
const TYPING_CHAR_MS = 35  // ms per character reveal

export function usePromptInputPlaceholder({
  input,
  submitCount,
  viewingAgentName,
}: Props): string | undefined {
  const queuedCommands = useCommandQueue()

  // Pre-build the pool once and cycle through it
  const pool = useRef<string[]>([])
  const [poolIndex, setPoolIndex] = useState(0)
  // How many characters of the current example are visible (typing effect)
  const [typedLength, setTypedLength] = useState(0)

  // Cycle to next example every EXAMPLE_CYCLE_MS
  useEffect(() => {
    if (submitCount >= 1) return
    if (proactiveModule?.isProactiveActive()) return
    pool.current = getExampleCommandPool(EXAMPLE_POOL_SIZE)
    // Start typing the first example immediately
    setTypedLength(0)
    const id = setInterval(() => {
      setPoolIndex(i => (i + 1) % EXAMPLE_POOL_SIZE)
      setTypedLength(0)
    }, EXAMPLE_CYCLE_MS)
    return () => clearInterval(id)
  }, [submitCount])

  // Typing animation: reveal one character at a time after each pool change
  useEffect(() => {
    const full = pool.current[poolIndex] ?? ''
    if (typedLength >= full.length) return
    const id = setTimeout(() => {
      setTypedLength(n => n + 1)
    }, TYPING_CHAR_MS)
    return () => clearTimeout(id)
  }, [poolIndex, typedLength])

  const placeholder = useMemo(() => {
    if (input !== '') {
      return
    }

    // Show teammate hint when viewing teammate
    if (viewingAgentName) {
      const displayName =
        viewingAgentName.length > MAX_TEAMMATE_NAME_LENGTH
          ? viewingAgentName.slice(0, MAX_TEAMMATE_NAME_LENGTH - 3) + '...'
          : viewingAgentName
      return `Message @${displayName}…`
    }

    // Show queue hint if user has not seen it yet.
    // Only count user-editable commands — task-notification and isMeta
    // are hidden from the prompt area (see PromptInputQueuedCommands).
    if (
      queuedCommands.some(isQueuedCommandEditable) &&
      (getGlobalConfig().queuedCommandUpHintCount || 0) <
        NUM_TIMES_QUEUE_HINT_SHOWN
    ) {
      return 'Press up to edit queued messages'
    }

    // Cycle through example command hints on first session start, with typing
    // animation. Skip in proactive mode — the model drives the conversation.
    if (submitCount < 1 && !proactiveModule?.isProactiveActive()) {
      const full = pool.current[poolIndex] ?? pool.current[0] ?? ''
      return full.slice(0, typedLength)
    }
  }, [
    input,
    queuedCommands,
    submitCount,
    viewingAgentName,
    poolIndex,
    typedLength,
  ])

  return placeholder
}
