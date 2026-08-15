import * as React from 'react';
import { Stats } from 'src/agent/ui/Stats.js';
import type { LocalJSXCommandCall } from 'src/shared/types/command.js';
export const call: LocalJSXCommandCall = async onDone => {
  return <Stats onClose={onDone} />;
};
