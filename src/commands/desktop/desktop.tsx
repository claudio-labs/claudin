import React from 'react';
import type { CommandResultDisplay } from 'src/commands.js';
import { DesktopHandoff } from 'src/components/DesktopHandoff.js';
export async function call(onDone: (result?: string, options?: {
  display?: CommandResultDisplay;
}) => void): Promise<React.ReactNode> {
  return <DesktopHandoff onDone={onDone} />;
}
