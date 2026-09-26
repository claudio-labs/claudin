import { toAgentId } from 'src/shared/types/ids.js'

const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/**
 * Why `name` cannot address the agent it is given to, or undefined when it
 * can. The name is what ListAgents prints and SendMessage resolves, so it must
 * resolve to this agent: not "main" or "*", nothing with an address's "@" or
 * "uds:", and nothing shaped like an agentId, which a send reads as that id.
 */
export function agentNameProblem(name: string): string | undefined {
  if (!AGENT_NAME_RE.test(name)) {
    return `name must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit — ${JSON.stringify(name)} is not`
  }
  if (name.toLowerCase() === 'main') {
    return '"main" is reserved: SendMessage reads it as the main conversation'
  }
  if (toAgentId(name) !== null) {
    return `${JSON.stringify(name)} is shaped like an agentId, and a send would resolve it as one — pick a word`
  }
  return undefined
}
