import * as React from 'react'
import { BLACK_CIRCLE } from 'src/shared/constants/figures.js'
import { Text } from 'src/terminal/ink.js'
import { toInkColor } from 'src/terminal/render/ink.js'

export type WorkerBadgeProps = {
  name: string
  color: string
}

/** `● @name` in the worker's colour, the name in bold. */
export function WorkerBadge({ name, color }: WorkerBadgeProps): React.ReactNode {
  return (
    <Text color={toInkColor(color)}>
      {BLACK_CIRCLE} <Text bold>@{name}</Text>
    </Text>
  )
}
