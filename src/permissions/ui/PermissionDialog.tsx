import * as React from 'react'
import { PermissionRequestTitle } from 'src/permissions/ui/PermissionRequestTitle.js'
import type { WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js'
import { Box } from 'src/terminal/ink.js'
import type { Theme } from 'src/terminal/theme/theme.js'

type PermissionDialogProps = {
  title: string
  subtitle?: React.ReactNode
  color?: keyof Theme
  titleColor?: keyof Theme
  innerPaddingX?: number
  workerBadge?: WorkerBadgeProps
  titleRight?: React.ReactNode
  children: React.ReactNode
}

/**
 * The frame a permission dialog is drawn in: a coloured rule across the
 * terminal, the title block, then the body.
 */
export function PermissionDialog({
  title,
  subtitle,
  color = 'permission',
  titleColor = 'permission',
  innerPaddingX = 1,
  workerBadge,
  titleRight,
  children,
}: PermissionDialogProps): React.ReactNode {
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      borderStyle="round"
      borderColor={color}
      borderLeft={false}
      borderRight={false}
      borderBottom={false}
    >
      <Box flexDirection="row" paddingX={1}>
        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
          <PermissionRequestTitle title={title} subtitle={subtitle} color={titleColor} workerBadge={workerBadge} />
        </Box>
        {/* The right-hand part keeps its width; the title wraps in what is left. */}
        {titleRight !== undefined && titleRight !== null && (
          <Box flexShrink={0} marginLeft={1}>
            {titleRight}
          </Box>
        )}
      </Box>
      <Box flexDirection="column" paddingX={innerPaddingX}>
        {children}
      </Box>
    </Box>
  )
}
