import * as React from 'react';
import { Settings } from 'src/platform/settings/ui/Settings.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <Settings onClose={onDone} context={context} defaultTab="Stats" />;
};
