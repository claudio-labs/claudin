import * as React from 'react';
import type { LocalJSXCommandOnDone } from 'src/types/command.js';
import { PluginSettings } from 'src/commands/plugin/PluginSettings.js';
export async function call(onDone: LocalJSXCommandOnDone, _context: unknown, args?: string): Promise<React.ReactNode> {
  return <PluginSettings onComplete={onDone} args={args} />;
}
