import * as React from 'react';
import { RemoteEnvironmentDialog } from 'src/platform/remote/RemoteEnvironmentDialog.js';
import type { LocalJSXCommandOnDone } from 'src/types/command.js';
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <RemoteEnvironmentDialog onDone={onDone} />;
}
