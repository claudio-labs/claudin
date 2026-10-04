import { feature } from 'bun:bundle';
import React from 'react';
import { Text } from 'src/terminal/ink.js';
import { permissionModeTitle } from 'src/permissions/PermissionMode.js';
import type { PermissionDecisionReason } from 'src/permissions/PermissionResult.js';
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js';
import { getSettingSourceDisplayNameLowercase } from 'src/platform/settings/constants.js';

export type ReasonKind = Exclude<PermissionDecisionReason['type'], 'subcommandResults'>;
export type ReasonOf<K extends PermissionDecisionReason['type']> = Extract<PermissionDecisionReason, { type: K }>;
type LineBuilder<K extends ReasonKind> = (reason: ReasonOf<K>) => React.ReactNode;

/** A name in bold followed by plain words, the bold ending before the space. */
function named(name: string, rest: string): React.ReactNode {
  return (
    <>
      <Text bold>{name}</Text> {rest}
    </>
  );
}

/** Classifier reasons exist only in builds that carry a classifier. */
function classifierReasonsShown(): boolean {
  if (feature('BASH_CLASSIFIER')) return true;
  if (feature('TRANSCRIPT_CLASSIFIER')) return true;
  return false;
}

const REASON_LINES: { [K in ReasonKind]: LineBuilder<K> } = {
  rule: ({ rule }) =>
    named(permissionRuleValueToString(rule.ruleValue), `rule from ${getSettingSourceDisplayNameLowercase(rule.source)}`),
  mode: ({ mode }) => `${permissionModeTitle(mode)} mode`,
  sandboxOverride: () => 'Requires permission to bypass sandbox',
  workingDir: ({ reason }) => reason,
  safetyCheck: ({ reason }) => reason,
  other: ({ reason }) => reason,
  asyncAgent: ({ reason }) => reason,
  permissionPromptTool: ({ permissionPromptToolName }) => named(permissionPromptToolName, 'permission prompt tool'),
  hook: ({ hookName, reason }) => named(hookName, reason ? `hook: ${reason}` : 'hook'),
  classifier: ({ classifier, reason }) => (classifierReasonsShown() ? named(classifier, `classifier: ${reason}`) : null),
};

/** The one-line form of a reason; null when the kind has nothing to show. */
export function reasonLine(reason: ReasonOf<ReasonKind>): React.ReactNode {
  const build = REASON_LINES[reason.type] as LineBuilder<typeof reason.type>;
  return build(reason);
}
