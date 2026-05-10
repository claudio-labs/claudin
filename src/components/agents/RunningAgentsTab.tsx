import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { formatTokens } from '../../utils/format.js'
import { Divider } from '../design-system/Divider.js'

export function RunningAgentsTab() {
  const tasks = useAppState((s: AppState) => s.tasks)

  const runningAgents = Object.values(tasks).filter(
    (task): task is LocalAgentTaskState =>
      task.type === 'local_agent' &&
      task.agentType !== 'main-session' &&
      (task.status === 'running' || task.status === 'pending'),
  )

  return (
    <Box flexDirection="column" paddingTop={1}>
      <Divider color="permission" />
      <Box flexDirection="column" paddingX={2}>
        {runningAgents.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>No subagents are currently running.</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1} gap={1}>
            {runningAgents.map(agent => {
              const tokenCount = agent.progress?.tokenCount ?? 0
              const toolCount = agent.progress?.toolUseCount ?? 0
              const model = agent.model ?? 'inherit'
              const lastActivity = agent.progress?.lastActivity
              return (
                <Box key={agent.id} flexDirection="column">
                  <Box flexDirection="row" gap={1}>
                    <Text bold>{agent.agentType}</Text>
                    <Text dimColor>·</Text>
                    <Text dimColor>{model}</Text>
                    <Text dimColor>·</Text>
                    <Text dimColor>{formatTokens(tokenCount)} tokens</Text>
                    {toolCount > 0 && (
                      <>
                        <Text dimColor>·</Text>
                        <Text dimColor>{toolCount} tool{toolCount !== 1 ? 's' : ''}</Text>
                      </>
                    )}
                  </Box>
                  {lastActivity && (
                    <Box paddingLeft={2}>
                      <Text dimColor italic>
                        {lastActivity.activityDescription ?? lastActivity.toolName}
                      </Text>
                    </Box>
                  )}
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    </Box>
  )
}
