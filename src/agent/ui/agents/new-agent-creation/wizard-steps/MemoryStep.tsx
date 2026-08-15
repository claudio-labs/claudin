import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode } from 'react';
import { Box } from 'src/terminal/ink.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import { isAutoMemoryEnabled } from 'src/memory/memdir/paths.js';
import { type AgentMemoryScope, loadAgentMemoryPrompt } from 'src/tools/AgentTool/agentMemory.js';
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js';
import { Select } from 'src/terminal/custom-select/select.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js';
import { useWizard } from 'src/terminal/wizard/index.js';
import { WizardDialogLayout } from 'src/terminal/wizard/WizardDialogLayout.js';
import type { AgentWizardData } from 'src/agent/ui/agents/new-agent-creation/types.js';
type MemoryOption = {
  label: string;
  value: AgentMemoryScope | 'none';
};
export function MemoryStep() {
  const $ = _c(13);
  const {
    goNext,
    goBack,
    updateWizardData,
    wizardData
  } = useWizard<AgentWizardData>();
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = {
      context: "Confirmation"
    };
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  useKeybinding("confirm:no", goBack, t0);
  const isUserScope = wizardData.location === "userSettings";
  let t1;
  if ($[1] !== isUserScope) {
    t1 = isUserScope ? [{
      label: "User scope (~/.claudin/agent-memory/) (Recommended)",
      value: "user"
    }, {
      label: "None (no persistent memory)",
      value: "none"
    }, {
      label: "Project scope (.claudin/agent-memory/)",
      value: "project"
    }, {
      label: "Local scope (.claudin/agent-memory-local/)",
      value: "local"
    }] : [{
      label: "Project scope (.claudin/agent-memory/) (Recommended)",
      value: "project"
    }, {
      label: "None (no persistent memory)",
      value: "none"
    }, {
      label: "User scope (~/.claudin/agent-memory/)",
      value: "user"
    }, {
      label: "Local scope (.claudin/agent-memory-local/)",
      value: "local"
    }];
    $[1] = isUserScope;
    $[2] = t1;
  } else {
    t1 = $[2];
  }
  const memoryOptions = t1;
  let t2;
  if ($[3] !== goNext || $[4] !== updateWizardData || $[5] !== wizardData.finalAgent || $[6] !== wizardData.systemPrompt) {
    t2 = (value: string) => {
      const memory = value === "none" ? undefined : value as AgentMemoryScope;
      const agentType = wizardData.finalAgent?.agentType;
      updateWizardData({
        selectedMemory: memory,
        finalAgent: wizardData.finalAgent ? {
          ...wizardData.finalAgent,
          memory,
          getSystemPrompt: isAutoMemoryEnabled() && memory && agentType ? () => wizardData.systemPrompt + "\n\n" + loadAgentMemoryPrompt(agentType, memory) : () => wizardData.systemPrompt!
        } : undefined
      });
      goNext();
    };
    $[3] = goNext;
    $[4] = updateWizardData;
    $[5] = wizardData.finalAgent;
    $[6] = wizardData.systemPrompt;
    $[7] = t2;
  } else {
    t2 = $[7];
  }
  const handleSelect = t2;
  let t3;
  if ($[8] === Symbol.for("react.memo_cache_sentinel")) {
    t3 = <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>;
    $[8] = t3;
  } else {
    t3 = $[8];
  }
  let t4;
  if ($[9] !== goBack || $[10] !== handleSelect || $[11] !== memoryOptions) {
    t4 = <WizardDialogLayout subtitle="Configure agent memory" footerText={t3}><Box><Select key="memory-select" options={memoryOptions} onChange={handleSelect} onCancel={goBack} /></Box></WizardDialogLayout>;
    $[9] = goBack;
    $[10] = handleSelect;
    $[11] = memoryOptions;
    $[12] = t4;
  } else {
    t4 = $[12];
  }
  return t4;
}
