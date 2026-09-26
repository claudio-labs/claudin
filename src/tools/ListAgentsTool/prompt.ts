export const DESCRIPTION = 'List the agents you can SendMessage to'

export function getPrompt({ swarm }: { swarm: boolean }): string {
  const who = swarm
    ? 'the other agents of this conversation (and, from a background agent, "main"), the teammates on your team, and the other interactive Claudin sessions on this machine'
    : 'the other agents of this conversation (and, from a background agent, "main") and the other interactive Claudin sessions on this machine'
  return `Lists agents you can SendMessage to — ${who}, in sections by kind. Names are the address: send with \`SendMessage({to: "<name>", message: "..."})\`, copying the name exactly as a row prints it. Append a session's \` [ref]\` only when the bare name is not enough — two rows share it, or an error asks you to disambiguate. A finished agent still answers: a send resumes it from its transcript.`
}
