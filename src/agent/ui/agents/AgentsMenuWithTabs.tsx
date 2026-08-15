import { useState } from 'react'
import { Box, Text, useInput } from 'src/terminal/ink.js'
import type { CommandResultDisplay } from 'src/commands.js'
import { useExitOnCtrlCDWithKeybindings } from 'src/terminal/hooks/useExitOnCtrlCDWithKeybindings.js'
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js'
import type { Tools } from 'src/Tool.js'
import { AgentsMenu } from 'src/agent/ui/agents/AgentsMenu.js'
import { RunningAgentsTab } from 'src/agent/ui/agents/RunningAgentsTab.js'

type Tab = 'running' | 'library'

type Props = {
  tools: Tools
  onExit: (result?: string, options?: { display?: CommandResultDisplay }) => void
}

function RunningFooter({ onExit }: { onExit: () => void }) {
  const exitState = useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onExit, { context: 'Confirmation', isActive: true })

  const hint = exitState.pending
    ? `Press ${exitState.keyName} again to exit`
    : '←/→ switch tabs · ↑↓ navigate · Enter select · Esc close'

  return (
    <Box marginLeft={2} marginTop={1}>
      <Text dimColor>{hint}</Text>
    </Box>
  )
}

export function AgentsMenuWithTabs({ tools, onExit }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('library')

  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- tabs:next/previous are not registered in keybinding schema for this context
  useInput((_input, key) => {
    if (key.leftArrow) setActiveTab('running')
    if (key.rightArrow) setActiveTab('library')
  }, { isActive: true })

  const tabBar = (
    <Box flexDirection="row" gap={1} marginBottom={0}>
      <Text bold color="permission">
        Agents
      </Text>
      <Text bold={activeTab === 'running'} inverse={activeTab === 'running'}>
        {' '}Running{' '}
      </Text>
      <Text bold={activeTab === 'library'} inverse={activeTab === 'library'}>
        {' '}Library{' '}
      </Text>
    </Box>
  )

  if (activeTab === 'running') {
    return (
      <Box flexDirection="column">
        {tabBar}
        <RunningAgentsTab />
        <RunningFooter onExit={() => onExit('Agents dialog dismissed', { display: 'system' })} />
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {tabBar}
      <AgentsMenu tools={tools} onExit={onExit} />
    </Box>
  )
}
