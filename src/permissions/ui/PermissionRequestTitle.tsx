import * as React from 'react'
import type { WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js'
import { Box, Text } from 'src/terminal/ink.js'
import type { Theme } from 'src/terminal/theme/theme.js'

type PermissionRequestTitleProps = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  workerBadge?: WorkerBadgeProps
}

/**
 * The title block: the bold title, the worker's handle on the same line,
 * and the subtitle under them. Title and handle are one `<Text>`, so they
 * wrap together as one sentence.
 */
export function PermissionRequestTitle({ title, subtitle, color = 'permission', workerBadge }: PermissionRequestTitleProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      <Text>
        <Text bold color={color}>
          {title}
        </Text>
        {workerBadge && (
          <>
            {' '}
            <Text dimColor>{`· @${workerBadge.name}`}</Text>
          </>
        )}
      </Text>
      <Subtitle subtitle={subtitle} />
    </Box>
  )
}

/** A string keeps one line and gives up its start first: a path's tail is the part worth reading. */
function Subtitle({ subtitle }: { subtitle: React.ReactNode }): React.ReactNode {
  if (subtitle === undefined || subtitle === null || subtitle === false || subtitle === '') return null
  if (typeof subtitle !== 'string') return subtitle
  return (
    <Text dimColor wrap="truncate-start">
      {subtitle}
    </Text>
  )
}
