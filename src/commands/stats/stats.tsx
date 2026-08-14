import * as React from 'react';
import { Stats } from 'src/components/Stats.js';
import type { LocalJSXCommandCall } from 'src/types/command.js';
export const call: LocalJSXCommandCall = async onDone => {
  return <Stats onClose={onDone} />;
};
