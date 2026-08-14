import * as React from 'react';
import type { LocalJSXCommandContext } from 'src/commands.js';
import { SkillsMenu } from 'src/components/skills/SkillsMenu.js';
import type { LocalJSXCommandOnDone } from 'src/types/command.js';
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext): Promise<React.ReactNode> {
  return <SkillsMenu onExit={onDone} commands={context.options.commands} />;
}
