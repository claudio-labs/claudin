import figures from 'figures';
import React, { useMemo } from 'react';
import { Box, Text } from 'src/terminal/ink.js';
import { useAppState } from 'src/terminal/state/AppState.js';
import type { AppState } from 'src/terminal/state/AppState.js';
import type { PermissionMode } from 'src/permissions/PermissionMode.js';
import { permissionModeTitle } from 'src/permissions/PermissionMode.js';
import type { PermissionDecision, PermissionDecisionReason, PermissionResult } from 'src/permissions/PermissionResult.js';
import { extractRules } from 'src/permissions/PermissionUpdate.js';
import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js';
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js';
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js';
import { detectUnreachableRules, type UnreachableRule } from 'src/permissions/shadowedRuleDetection.js';
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js';
import { reasonLine } from 'src/permissions/ui/decisionDebug/reasonLine.js';
import { Row } from 'src/permissions/ui/decisionDebug/Row.js';
import { relevantUnreachableRules } from 'src/permissions/ui/decisionDebug/unreachableRules.js';

type Props = {
  /**
   * `message` is read directly for the debug row; an `allow` decision simply
   * has none, hence the optional widening over the union.
   */
  permissionResult: PermissionDecision & {
    message?: string;
  };
  toolName?: string;
};

const selectPermissionContext = (state: AppState) => state.toolPermissionContext;

function sandboxAutoAllowsBash(): boolean {
  return SandboxManager.isSandboxingEnabled() && SandboxManager.isAutoAllowBashIfSandboxedEnabled();
}

function boldList(rules: readonly PermissionRuleValue[]): React.ReactNode {
  return rules.map((rule, index) => (
    <React.Fragment key={index}>
      {index > 0 ? ', ' : ''}
      <Text bold>{permissionRuleValueToString(rule)}</Text>
    </React.Fragment>
  ));
}

function SubcommandResult({ command, result }: { command: string; result: PermissionResult }): React.ReactNode {
  const allowed = result.behavior === 'allow';
  const reason = result.decisionReason;
  const line = reason && reason.type !== 'subcommandResults' ? reasonLine(reason) : null;
  const suggested = result.behavior === 'ask' ? extractRules(result.suggestions) : [];
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={allowed ? 'success' : 'error'}>{allowed ? figures.tick : figures.cross}</Text> {command}
      </Text>
      {line ? <Text>{'⎿  '}{line}</Text> : null}
      {suggested.length > 0 ? (
        <Text>
          {'⎿  Suggested rules: '}
          {boldList(suggested)}
        </Text>
      ) : null}
    </Box>
  );
}

function ReasonValue({ reason }: { reason: PermissionDecisionReason | undefined }): React.ReactNode {
  if (!reason) return <Text>undefined</Text>;
  if (reason.type !== 'subcommandResults') {
    const line = reasonLine(reason);
    return line === null ? null : <Text>{line}</Text>;
  }
  return [...reason.reasons].map(([command, result]) => <SubcommandResult key={command} command={command} result={result} />);
}

function bulleted(items: readonly string[]): React.ReactNode {
  return items.map((item, index) => (
    <Text key={index}>
      {figures.bullet} {item}
    </Text>
  ));
}

function suggestedDirectories(updates: readonly PermissionUpdate[]): string[] {
  return updates.flatMap(update => (update.type === 'addDirectories' ? update.directories : []));
}

function suggestedMode(updates: readonly PermissionUpdate[]): PermissionMode | undefined {
  let mode: PermissionMode | undefined;
  for (const update of updates) {
    if (update.type === 'setMode') mode = update.mode;
  }
  return mode;
}

function Suggestions({ suggestions }: { suggestions: PermissionUpdate[] | undefined }): React.ReactNode {
  const updates = suggestions ?? [];
  const rules = extractRules(updates);
  const directories = suggestedDirectories(updates);
  const mode = suggestedMode(updates);
  if (rules.length === 0 && directories.length === 0 && mode === undefined) return <Text>Suggestions None</Text>;
  return (
    <Box flexDirection="column">
      <Text>Suggestions</Text>
      {rules.length > 0 ? <Row label="Rules">{bulleted(rules.map(permissionRuleValueToString))}</Row> : null}
      {directories.length > 0 ? <Row label="Dirs">{bulleted(directories)}</Row> : null}
      {mode !== undefined ? <Row label="Mode">{permissionModeTitle(mode)}</Row> : null}
    </Box>
  );
}

function UnreachableRules({ rules }: { rules: readonly UnreachableRule[] }): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="warning">
        {figures.warning} Unreachable Rules ({rules.length})
      </Text>
      {rules.map((unreachable, index) => (
        <Box key={index} flexDirection="column" marginLeft={2}>
          <Text color="warning">{permissionRuleValueToString(unreachable.rule.ruleValue)}</Text>
          <Box flexDirection="column" marginLeft={2}>
            <Text dimColor>{unreachable.reason}</Text>
            <Text dimColor>Fix: {unreachable.fix}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

/**
 * The ctrl+d view of a permission decision. It shows the decision as it
 * already is and reads the app state only; it never changes either.
 */
export function PermissionDecisionDebugInfo({ permissionResult, toolName }: Props): React.ReactNode {
  const permissionContext = useAppState(selectPermissionContext);
  const suggestions = permissionResult.behavior === 'ask' ? permissionResult.suggestions : undefined;
  const unreachable = useMemo(
    () =>
      relevantUnreachableRules(
        detectUnreachableRules(permissionContext, { sandboxAutoAllowEnabled: sandboxAutoAllowsBash() }),
        suggestions,
        toolName,
      ),
    [permissionContext, suggestions, toolName],
  );

  return (
    <Box flexDirection="column">
      <Row label="Behavior">{permissionResult.behavior}</Row>
      {permissionResult.behavior !== 'allow' ? <Row label="Message">{permissionResult.message}</Row> : null}
      <Row label="Reason">
        <ReasonValue reason={permissionResult.decisionReason} />
      </Row>
      <Suggestions suggestions={suggestions} />
      {unreachable.length > 0 ? <UnreachableRules rules={unreachable} /> : null}
    </Box>
  );
}
