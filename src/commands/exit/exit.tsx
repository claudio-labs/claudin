import sample from 'lodash-es/sample.js';
import * as React from 'react';
import { ExitFlow } from 'src/platform/ExitFlow.js';
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js';
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js';
import { getCurrentWorktreeSession } from 'src/vcs/git/worktree.js';
const GOODBYE_MESSAGES = ['Goodbye!', 'See ya!', 'Bye!', 'Catch you later!'];
function getRandomGoodbyeMessage(): string {
  return sample(GOODBYE_MESSAGES) ?? 'Goodbye!';
}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  const showWorktree = getCurrentWorktreeSession() !== null;
  if (showWorktree) {
    return <ExitFlow showWorktree={showWorktree} onDone={onDone} onCancel={() => onDone()} />;
  }
  onDone(getRandomGoodbyeMessage());
  await gracefulShutdown(0, 'prompt_input_exit');
  return null;
}
