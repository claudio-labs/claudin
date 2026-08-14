import figures from 'figures';
import * as React from 'react';
import type { SettingSource } from 'src/utils/settings/constants.js';
import type { KeyboardEvent } from 'src/ink/events/keyboard-event.js';
import { Box, Text } from 'src/ink.js';
import type { ResolvedAgent } from 'src/tools/AgentTool/agentDisplay.js';
import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  resolveAgentModelDisplay,
} from 'src/tools/AgentTool/agentDisplay.js';
import type { AgentDefinition } from 'src/tools/AgentTool/loadAgentsDir.js';
import { count } from 'src/utils/array.js';
import { Dialog } from 'src/components/design-system/Dialog.js';
import { Divider } from 'src/components/design-system/Divider.js';
import { getAgentSourceDisplayName } from './utils.js';

type Props = {
  source: SettingSource | 'all' | 'built-in' | 'plugin';
  agents: ResolvedAgent[];
  onBack: () => void;
  onSelect: (agent: AgentDefinition) => void;
  onCreateNew?: () => void;
  changes?: string[];
};

const NAME_COL_MIN = 20;
const MODEL_COL_MIN = 12;

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function getOverrideInfo(agent: ResolvedAgent) {
  return {
    isOverridden: !!agent.overriddenBy,
    overriddenBy: agent.overriddenBy || null,
  };
}

type ColumnWidths = {
  name: number;
  model: number;
};

function computeColumnWidths(agents: ResolvedAgent[]): ColumnWidths {
  // These are *content* widths. The selectable pointer prefix (2 chars) is
  // added in the Box width itself, not folded into the name column, so a
  // terminal-narrow agent name still gets truncated correctly.
  let name = NAME_COL_MIN;
  let model = MODEL_COL_MIN;
  for (const agent of agents) {
    if (agent.agentType.length > name) name = agent.agentType.length;
    const m = resolveAgentModelDisplay(agent);
    if (m && m.length > model) model = m.length;
  }
  // Cap to keep things sane on narrow terminals.
  return {
    name: Math.min(name, 32),
    model: Math.min(model, 28),
  };
}

type AgentRowProps = {
  agent: ResolvedAgent;
  isSelected: boolean;
  dimmed: boolean;
  widths: ColumnWidths;
  selectable: boolean;
};

function AgentRow({ agent, isSelected, dimmed, widths, selectable }: AgentRowProps) {
  const { isOverridden, overriddenBy } = getOverrideInfo(agent);
  const rowDim = dimmed && !isSelected;
  const textColor = selectable && isSelected ? 'suggestion' : undefined;
  const resolvedModel = resolveAgentModelDisplay(agent) ?? '';
  const pointer = selectable ? (isSelected ? `${figures.pointer} ` : '  ') : '';

  return (
    <Box key={`${agent.agentType}-${agent.source}`} flexDirection="row">
      <Box width={widths.name + (selectable ? 2 : 0)} flexShrink={0}>
        <Text dimColor={rowDim} color={textColor}>
          {pointer}
          {truncate(agent.agentType, widths.name)}
        </Text>
      </Box>
      <Box width={widths.model + 2} flexShrink={0}>
        <Text dimColor={true} color={textColor}>
          {truncate(resolvedModel, widths.model)}
        </Text>
      </Box>
      {overriddenBy && (
        <Box flexShrink={0}>
          <Text
            dimColor={!isSelected}
            color={isSelected ? 'warning' : undefined}
          >
            {figures.warning} shadowed by {getOverrideSourceLabel(overriddenBy)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function ColumnHeader({
  widths,
  selectable,
}: {
  widths: ColumnWidths;
  selectable: boolean;
}) {
  return (
    <Box flexDirection="row">
      <Box width={widths.name + (selectable ? 2 : 0)} flexShrink={0}>
        <Text dimColor={true}>{selectable ? '  Name' : 'Name'}</Text>
      </Box>
      <Box width={widths.model + 2} flexShrink={0}>
        <Text dimColor={true}>Model</Text>
      </Box>
    </Box>
  );
}

export function AgentsList({
  source,
  agents,
  onBack,
  onSelect,
  onCreateNew,
  changes,
}: Props) {
  const [selectedAgent, setSelectedAgent] = React.useState<ResolvedAgent | null>(null);
  const [isCreateNewSelected, setIsCreateNewSelected] = React.useState(true);

  const sortedAgents = React.useMemo(
    () => [...agents].sort(compareAgentsByName),
    [agents],
  );

  const columnWidths = React.useMemo(
    () => computeColumnWidths(sortedAgents),
    [sortedAgents],
  );

  // Built-in agents are selectable so the user can open the agent menu and
  // hit "Change model" — they appear last in the navigation order to match
  // their visual position in the list.
  const selectableAgentsInOrder = React.useMemo(() => {
    if (source === 'all') {
      return AGENT_SOURCE_GROUPS.flatMap(({ source: groupSource }) =>
        sortedAgents.filter(a => a.source === groupSource),
      );
    }
    if (source === 'built-in') {
      return sortedAgents.filter(a => a.source === 'built-in');
    }
    const nonBuiltIn = sortedAgents.filter(a => a.source !== 'built-in');
    const builtIn = sortedAgents.filter(a => a.source === 'built-in');
    return [...nonBuiltIn, ...builtIn];
  }, [sortedAgents, source]);

  React.useEffect(() => {
    if (!selectedAgent && !isCreateNewSelected && selectableAgentsInOrder.length > 0) {
      if (onCreateNew) {
        setIsCreateNewSelected(true);
      } else {
        setSelectedAgent(selectableAgentsInOrder[0] || null);
      }
    }
  }, [selectableAgentsInOrder, selectedAgent, isCreateNewSelected, onCreateNew]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'return') {
      e.preventDefault();
      if (isCreateNewSelected && onCreateNew) {
        onCreateNew();
      } else if (selectedAgent) {
        onSelect(selectedAgent);
      }
      return;
    }
    if (e.key !== 'up' && e.key !== 'down') return;
    e.preventDefault();
    const hasCreateOption = !!onCreateNew;
    const totalItems = selectableAgentsInOrder.length + (hasCreateOption ? 1 : 0);
    if (totalItems === 0) return;
    let currentPosition = 0;
    if (!isCreateNewSelected && selectedAgent) {
      const agentIndex = selectableAgentsInOrder.findIndex(
        a => a.agentType === selectedAgent.agentType && a.source === selectedAgent.source,
      );
      if (agentIndex >= 0) {
        currentPosition = hasCreateOption ? agentIndex + 1 : agentIndex;
      }
    }
    const newPosition =
      e.key === 'up'
        ? currentPosition === 0
          ? totalItems - 1
          : currentPosition - 1
        : currentPosition === totalItems - 1
          ? 0
          : currentPosition + 1;
    if (hasCreateOption && newPosition === 0) {
      setIsCreateNewSelected(true);
      setSelectedAgent(null);
    } else {
      const agentIndex = hasCreateOption ? newPosition - 1 : newPosition;
      const next = selectableAgentsInOrder[agentIndex];
      if (next) {
        setIsCreateNewSelected(false);
        setSelectedAgent(next);
      }
    }
  };

  const renderCreateNewOption = () => (
    <Box>
      <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
        {isCreateNewSelected ? `${figures.pointer} ` : '  '}
      </Text>
      <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
        Create new agent
      </Text>
    </Box>
  );

  const renderAgent = (agent: ResolvedAgent) => {
    const isSelected =
      !isCreateNewSelected &&
      selectedAgent?.agentType === agent.agentType &&
      selectedAgent?.source === agent.source;
    const { isOverridden } = getOverrideInfo(agent);
    const dimmed = isOverridden;
    return (
      <AgentRow
        key={`${agent.agentType}-${agent.source}`}
        agent={agent}
        isSelected={!!isSelected}
        dimmed={dimmed}
        widths={columnWidths}
        selectable={true}
      />
    );
  };

  const renderBuiltInAgentsSection = (
    title = 'Built-in (always available):',
  ) => {
    const builtInAgents = sortedAgents.filter(a => a.source === 'built-in');
    if (builtInAgents.length === 0) return null;
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text bold={true} dimColor={true}>
          {title}
        </Text>
        <ColumnHeader widths={columnWidths} selectable={true} />
        {builtInAgents.map(renderAgent)}
      </Box>
    );
  };

  const renderAgentGroup = (title: string, groupAgents: ResolvedAgent[]) => {
    if (!groupAgents.length) return null;
    const folderPath = groupAgents[0]?.baseDir;
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold={true} dimColor={true}>
            {title}
          </Text>
          {folderPath && <Text dimColor={true}> ({folderPath})</Text>}
        </Box>
        <Box paddingLeft={2}>
          <ColumnHeader widths={columnWidths} selectable={true} />
        </Box>
        {groupAgents.map(renderAgent)}
      </Box>
    );
  };

  const sourceTitle = getAgentSourceDisplayName(source);
  const builtInAgents = sortedAgents.filter(a => a.source === 'built-in');
  const hasNoAgents =
    !sortedAgents.length ||
    (source !== 'built-in' && !sortedAgents.some(a => a.source !== 'built-in'));

  if (hasNoAgents) {
    return (
      <Dialog
        title={sourceTitle}
        subtitle="No agents found"
        onCancel={onBack}
        hideInputGuide={true}
      >
        <Box
          flexDirection="column"
          gap={1}
          tabIndex={0}
          autoFocus={true}
          onKeyDown={handleKeyDown}
        >
          {onCreateNew && <Box>{renderCreateNewOption()}</Box>}
          <Text dimColor={true}>
            No agents found. Create specialized subagents that Claude can delegate to.
          </Text>
          <Text dimColor={true}>
            Each subagent has its own context window, custom system prompt, and specific tools.
          </Text>
          <Text dimColor={true}>
            Try creating: Code Reviewer, Code Simplifier, Security Reviewer, Tech Lead, or UX Reviewer.
          </Text>
          {source !== 'built-in' &&
            sortedAgents.some(a => a.source === 'built-in') &&
            renderBuiltInAgentsSection()}
        </Box>
      </Dialog>
    );
  }

  const agentCount = count(sortedAgents, a => !a.overriddenBy);

  let body: React.ReactNode;
  if (source === 'all') {
    body = (
      <>
        {AGENT_SOURCE_GROUPS.filter(g => g.source !== 'built-in').map(
          ({ label, source: groupSource }) => (
            <React.Fragment key={groupSource}>
              {renderAgentGroup(
                label,
                sortedAgents.filter(a => a.source === groupSource),
              )}
            </React.Fragment>
          ),
        )}
        {builtInAgents.length > 0 && (
          <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
            <Text dimColor={true}>
              <Text bold={true}>Built-in agents</Text> (always available)
            </Text>
            <ColumnHeader widths={columnWidths} selectable={true} />
            {builtInAgents.map(renderAgent)}
          </Box>
        )}
      </>
    );
  } else if (source === 'built-in') {
    body = (
      <>
        <Text dimColor={true} italic={true}>
          Select a built-in agent and press Enter to change its model.
        </Text>
        <Box marginTop={1} flexDirection="column">
          <ColumnHeader widths={columnWidths} selectable={true} />
          {sortedAgents.map(renderAgent)}
        </Box>
      </>
    );
  } else {
    body = (
      <>
        <Box flexDirection="column">
          <ColumnHeader widths={columnWidths} selectable={true} />
          {sortedAgents.filter(a => a.source !== 'built-in').map(renderAgent)}
        </Box>
        {sortedAgents.some(a => a.source === 'built-in') && (
          <>
            <Divider />
            {renderBuiltInAgentsSection()}
          </>
        )}
      </>
    );
  }

  return (
    <Dialog
      title={sourceTitle}
      subtitle={`${agentCount} agents`}
      onCancel={onBack}
      hideInputGuide={true}
    >
      {changes && changes.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor={true}>{changes[changes.length - 1]}</Text>
        </Box>
      )}
      <Box
        flexDirection="column"
        tabIndex={0}
        autoFocus={true}
        onKeyDown={handleKeyDown}
      >
        {onCreateNew && <Box marginBottom={1}>{renderCreateNewOption()}</Box>}
        {body}
      </Box>
    </Dialog>
  );
}
