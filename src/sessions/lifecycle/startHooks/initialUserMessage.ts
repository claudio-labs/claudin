/**
 * The first user message a SessionStart hook asked for. It waits here until
 * the headless runner takes it, once; a later start without one leaves it.
 */
let waiting: string | undefined

export function holdInitialUserMessage(message: string): void {
  waiting = message
}

export function takeInitialUserMessage(): string | undefined {
  const message = waiting
  waiting = undefined
  return message
}
