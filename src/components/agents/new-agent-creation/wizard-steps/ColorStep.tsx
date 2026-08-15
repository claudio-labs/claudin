import { c as _c } from "react-compiler-runtime";
import React, { type ReactNode } from 'react';
import { Box } from 'src/terminal/ink.js';
import { useKeybinding } from 'src/terminal/keybindings/useKeybinding.js';
import type { AgentColorName } from 'src/tools/AgentTool/agentColorManager.js';
import { ConfigurableShortcutHint } from 'src/terminal/ConfigurableShortcutHint.js';
import { Byline } from 'src/terminal/design-system/Byline.js';
import { KeyboardShortcutHint } from 'src/terminal/design-system/KeyboardShortcutHint.js';
import { useWizard } from 'src/terminal/wizard/index.js';
import { WizardDialogLayout } from 'src/terminal/wizard/WizardDialogLayout.js';
import { ColorPicker } from 'src/components/agents/ColorPicker.js';
import type { AgentWizardData } from 'src/components/agents/new-agent-creation/types.js';
export function ColorStep() {
  const $ = _c(14);
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
  let t1;
  if ($[1] !== goNext || $[2] !== updateWizardData || $[3] !== wizardData.agentType || $[4] !== wizardData.location || $[5] !== wizardData.selectedModel || $[6] !== wizardData.selectedTools || $[7] !== wizardData.systemPrompt || $[8] !== wizardData.whenToUse) {
    t1 = (color: AgentColorName | undefined) => {
      updateWizardData({
        selectedColor: color,
        finalAgent: {
          agentType: wizardData.agentType!,
          whenToUse: wizardData.whenToUse!,
          getSystemPrompt: () => wizardData.systemPrompt!,
          tools: wizardData.selectedTools,
          ...(wizardData.selectedModel ? {
            model: wizardData.selectedModel
          } : {}),
          ...(color ? {
            color: color as AgentColorName
          } : {}),
          source: wizardData.location!
        }
      });
      goNext();
    };
    $[1] = goNext;
    $[2] = updateWizardData;
    $[3] = wizardData.agentType;
    $[4] = wizardData.location;
    $[5] = wizardData.selectedModel;
    $[6] = wizardData.selectedTools;
    $[7] = wizardData.systemPrompt;
    $[8] = wizardData.whenToUse;
    $[9] = t1;
  } else {
    t1 = $[9];
  }
  const handleConfirm = t1;
  let t2;
  if ($[10] === Symbol.for("react.memo_cache_sentinel")) {
    t2 = <Byline><KeyboardShortcutHint shortcut={"\u2191\u2193"} action="navigate" /><KeyboardShortcutHint shortcut="Enter" action="select" /><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="go back" /></Byline>;
    $[10] = t2;
  } else {
    t2 = $[10];
  }
  const t3 = wizardData.agentType || "agent";
  let t4;
  if ($[11] !== handleConfirm || $[12] !== t3) {
    t4 = <WizardDialogLayout subtitle="Choose background color" footerText={t2}><Box><ColorPicker agentName={t3} currentColor="automatic" onConfirm={handleConfirm} /></Box></WizardDialogLayout>;
    $[11] = handleConfirm;
    $[12] = t3;
    $[13] = t4;
  } else {
    t4 = $[13];
  }
  return t4;
}
