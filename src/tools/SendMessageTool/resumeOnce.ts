/**
 * One resume of an agent at a time. Two sends that reach the same stopped
 * agent together would each resume it — two runs of one agent from one
 * transcript. The resume only marks the agent running after it has read the
 * transcript, so checking its status again is no guard; the promise is.
 */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * `resumed` for the send that started the run; `joined` for a send that
 * arrived while it was starting, once it is running — that one queues its
 * message into the run instead. A failed resume fails both.
 */
export async function resumeOnce<T>(
  agentId: string,
  resume: () => Promise<T>,
): Promise<{ resumed: T } | { joined: true }> {
  const starting = inFlight.get(agentId)
  if (starting) {
    await starting
    return { joined: true }
  }
  const run = resume()
  inFlight.set(agentId, run)
  try {
    return { resumed: await run }
  } finally {
    inFlight.delete(agentId)
  }
}
