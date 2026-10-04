import * as React from 'react'
import { useState } from 'react'
import { getAgentName, getTeammateColor, getTeamName } from 'src/agent/coordinator/teammate.js'
import { WorkerBadge, type WorkerBadgeProps } from 'src/permissions/ui/WorkerBadge.js'
import { Box, Text } from 'src/terminal/ink.js'
import { Spinner } from 'src/terminal/spinner/Spinner.js'

type WorkerPendingPermissionProps = {
  toolName: string
  description: string
}

type TeamSeat = { badge: WorkerBadgeProps | undefined; team: string | undefined }

function readTeamSeat(): TeamSeat {
  const name = getAgentName()
  const color = getTeammateColor()
  return { badge: name && color ? { name, color } : undefined, team: getTeamName() || undefined }
}

/**
 * The card a worker shows while the team lead decides on its request.
 * Each label shares one `<Text>` with its value, so a narrow terminal wraps
 * the line as a sentence instead of as side-by-side columns.
 */
export function WorkerPendingPermission({ toolName, description }: WorkerPendingPermissionProps): React.ReactNode {
  // Read once: the card keeps the seat it was mounted with.
  const [seat] = useState(readTeamSeat)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} width="100%">
      <Box flexDirection="row" marginBottom={1}>
        <Box flexShrink={0}>
          <Spinner />
        </Box>
        <Text bold color="warning">
          {' Waiting for team lead approval'}
        </Text>
      </Box>
      {seat.badge && (
        <Box marginBottom={1}>
          <WorkerBadge name={seat.badge.name} color={seat.badge.color} />
        </Box>
      )}
      <Text wrap="wrap-trim">
        <Text dimColor>Tool: </Text>
        {toolName}
      </Text>
      <Text wrap="wrap-trim">
        <Text dimColor>Action: </Text>
        {description}
      </Text>
      {seat.team && (
        <Box marginTop={1}>
          <Text dimColor wrap="wrap-trim">{`Permission request sent to team "${seat.team}" leader`}</Text>
        </Box>
      )}
    </Box>
  )
}
