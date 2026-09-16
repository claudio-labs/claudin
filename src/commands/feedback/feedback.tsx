import * as React from 'react';
import type { CommandResultDisplay, LocalJSXCommandContext } from 'src/commands/commands.js';
import { Feedback } from 'src/platform/Feedback.js';
import type { LocalJSXCommandOnDone } from 'src/shared/types/command.js';

// Shared function to render the Feedback component
export function renderFeedbackComponent(onDone: (result?: string, options?: {
  display?: CommandResultDisplay;
}) => void, abortSignal: AbortSignal, initialDescription: string = ''): React.ReactNode {
  return <Feedback abortSignal={abortSignal} initialDescription={initialDescription} onDone={onDone} />;
}
export async function call(onDone: LocalJSXCommandOnDone, context: LocalJSXCommandContext, args?: string): Promise<React.ReactNode> {
  const initialDescription = args || '';
  return renderFeedbackComponent(onDone, context.abortController.signal, initialDescription);
}
