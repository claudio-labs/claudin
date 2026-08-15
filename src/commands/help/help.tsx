import * as React from 'react';
import { HelpV2 } from 'src/platform/help/HelpV2.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
export const call: LocalJSXCommandCall = async (onDone, {
  options: {
    commands
  }
}) => {
  return <HelpV2 commands={commands} onClose={onDone} />;
};
