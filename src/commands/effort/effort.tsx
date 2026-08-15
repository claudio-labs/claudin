import { c as _c } from "react-compiler-runtime";
import * as React from 'react';
import { useMainLoopModel } from 'src/agent/hooks/useMainLoopModel.js';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/platform/analytics/index.js';
import { type AppState, useAppState, useSetAppState } from 'src/terminal/state/AppState.js';
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js';
import { type EffortValue, clearProjectEffortPin, effortEnvOverrideConflictsWith, getDisplayedEffortLabel, getEffortEnvOverride, getEffortValueDescription, getInitialEffortSetting, getProjectEffortOrigin, isEffortLevel, isOpenAIEffortLevel, modelUsesOpenAIEffort, persistEffortForProject, pinProjectEffortAuto, toPersistableEffort } from 'src/utils/effort.js';
import { EffortPicker } from 'src/providers/ui/EffortPicker.js';
const COMMON_HELP_ARGS = ['help', '-h', '--help'];
type EffortCommandResult = {
  message: string;
  effortUpdate?: {
    value: EffortValue | undefined;
  };
};
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  const persistable = toPersistableEffort(effortValue);
  const result = persistEffortForProject(effortValue);
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — compared by level bucket (shared with the Shift+arrow hotkey)
  // so a numeric override landing on the same level as the user's pick is not
  // flagged as noise.
  if (effortEnvOverrideConflictsWith(effortValue)) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    if (persistable === undefined) {
      return {
        message: `Not applied: CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides effort this session, and ${effortValue} is session-only (nothing saved)`,
        effortUpdate: {
          value: effortValue
        }
      };
    }
    return {
      message: `CLAUDE_CODE_EFFORT_LEVEL=${envRaw} overrides this session — clear it and ${effortValue} takes over`,
      effortUpdate: {
        value: effortValue
      }
    };
  }
  const description = getEffortValueDescription(effortValue);
  const suffix = persistable !== undefined ? ' for this project' : ' (this session only)';
  return {
    message: `Set effort level to ${effortValue}${suffix}: ${description}`,
    effortUpdate: {
      value: effortValue
    }
  };
}

/**
 * Where the effort in play came from. Only meaningful when no env override is
 * pinning the session, so callers gate on that before appending it.
 */
function effortScopeSuffix(): string {
  switch (getProjectEffortOrigin()) {
    case 'project':
      return ' — pinned for this project';
    case 'project-auto':
      return ' — auto pinned for this project';
    case 'global':
      return ' — inherited from global settings';
    case 'none':
      return '';
  }
}

export function showCurrentEffort(appStateEffort: EffortValue | undefined, model: string): EffortCommandResult {
  const envOverride = getEffortEnvOverride();
  const effectiveValue = envOverride === null ? undefined : envOverride ?? appStateEffort;
  const scope = envOverride !== undefined ? '' : effortScopeSuffix();
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLabel(model, appStateEffort);
    return {
      message: `Effort level: auto (currently ${level})${scope}`
    };
  }
  const description = getEffortValueDescription(effectiveValue);
  return {
    message: `Current effort level: ${effectiveValue} (${description})${scope}`
  };
}
function unsetEffortLevel(): EffortCommandResult {
  const result = pinProjectEffortAuto();
  if (result.error) {
    return {
      message: `Failed to set effort level: ${result.error.message}`
    };
  }
  logEvent('tengu_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride();
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.CLAUDE_CODE_EFFORT_LEVEL;
    return {
      message: `Pinned auto effort for this project, but CLAUDE_CODE_EFFORT_LEVEL=${envRaw} still controls this session`,
      effortUpdate: {
        value: undefined
      }
    };
  }
  return {
    message: 'Effort level set to auto for this project (model default, ignores the global setting)',
    effortUpdate: {
      value: undefined
    }
  };
}

/**
 * `/effort inherit` — drop the project pin so the global `settings.effortLevel`
 * (or the model default, when there is none) applies again.
 */
function inheritEffortLevel(): EffortCommandResult {
  const result = clearProjectEffortPin();
  if (result.error) {
    return {
      message: `Failed to clear the project effort pin: ${result.error.message}`
    };
  }
  // Read AFTER clearing: with no pin left this resolves the inherited value.
  const inherited = getInitialEffortSetting();
  logEvent('tengu_effort_command', {
    effort: 'inherit' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
  });
  return {
    message: inherited === undefined ? 'Cleared this project\u2019s effort pin — using the model default' : `Cleared this project\u2019s effort pin — now inheriting ${inherited} from global settings`,
    effortUpdate: {
      value: inherited
    }
  };
}
export function executeEffort(args: string): EffortCommandResult {
  const normalized = args.toLowerCase();
  if (normalized === 'inherit') {
    return inheritEffortLevel();
  }
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel();
  }
  if (isEffortLevel(normalized)) {
    return setEffortValue(normalized);
  }
  if (isOpenAIEffortLevel(normalized)) {
    return setEffortValue(normalized);
  }
  return {
    message: `Invalid argument: ${args}. Valid options are: low, medium, high, max, xhigh, auto, inherit`
  };
}
function ShowCurrentEffort(t0: { onDone: LocalJSXCommandOnDone }) {
  const {
    onDone
  } = t0;
  const effortValue = useAppState(_temp);
  const model = useMainLoopModel();
  const {
    message
  } = showCurrentEffort(effortValue, model);
  onDone(message);
  return null;
}
function _temp(s: AppState) {
  return s.effortValue;
}
function ApplyEffortAndClose(t0: {
  result: EffortCommandResult;
  onDone: LocalJSXCommandOnDone;
}) {
  const $ = _c(6);
  const {
    result,
    onDone
  } = t0;
  const setAppState = useSetAppState();
  const {
    effortUpdate,
    message
  } = result;
  let t1;
  let t2;
  if ($[0] !== effortUpdate || $[1] !== message || $[2] !== onDone || $[3] !== setAppState) {
    t1 = () => {
      if (effortUpdate) {
        setAppState(prev => ({
          ...prev,
          effortValue: effortUpdate.value
        }));
      }
      onDone(message);
    };
    t2 = [setAppState, effortUpdate, message, onDone];
    $[0] = effortUpdate;
    $[1] = message;
    $[2] = onDone;
    $[3] = setAppState;
    $[4] = t1;
    $[5] = t2;
  } else {
    t1 = $[4];
    t2 = $[5];
  }
  React.useEffect(t1, t2);
  return null;
}
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  args = args?.trim() || '';
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone('Usage: /effort [adaptive|low|medium|high|xhigh|max|auto|inherit]\n\nThe choice is saved for the current project. Projects with no choice of their own inherit the global effortLevel from settings.json.\n\nEffort levels:\n- adaptive: Model picks effort per request (low–xhigh, never max)\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- xhigh: Extended capability for long-horizon work (Opus 4.7/4.8, Fable 5, Sonnet 5, OpenAI/Codex)\n- max: Maximum capability with deepest reasoning (Opus 4.6/4.7/4.8, Fable 5, Sonnet 5)\n- auto: Use the default effort level for your model, ignoring the global setting\n- inherit: Drop this project\u2019s choice and follow the global setting again');
    return;
  }
  if (args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />;
  }
  if (!args) {
    return <EffortPickerWrapper onDone={onDone} />;
  }
  const result = executeEffort(args);
  return <ApplyEffortAndClose result={result} onDone={onDone} />;
}

function EffortPickerWrapper({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const setAppState = useSetAppState();
  const model = useMainLoopModel();
  const usesOpenAIEffort = modelUsesOpenAIEffort(model);

  function handleSelect(effort: EffortValue | undefined) {
    const persistable = toPersistableEffort(effort);
    // A picker choice is always an explicit decision: `undefined` here means
    // "model default", which is the 'auto' pin, not "don't save anything".
    if (effort === undefined) {
      pinProjectEffortAuto();
    } else {
      persistEffortForProject(effort);
    }
    logEvent('tengu_effort_command', {
      effort: (effort ?? 'auto') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
    });
    setAppState(prev => ({
      ...prev,
      effortValue: effort
    }));
    const description = effort ? getEffortValueDescription(effort) : 'Use default effort level for your model';
    const saved = effort === undefined || persistable !== undefined;
    const suffix = saved ? ' for this project' : ' (this session only)';
    onDone(`Set effort level to ${effort ?? 'auto'}${suffix}: ${description}`);
  }

  function handleCancel() {
    onDone('Cancelled');
  }

  return <EffortPicker onSelect={handleSelect} onCancel={handleCancel} />;
}
