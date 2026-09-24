export const DESCRIPTION = 'List the agents you can SendMessage to'

export function getPrompt({ swarm }: { swarm: boolean }): string {
  const who = swarm
    ? 'the background agents you spawned and the teammates on your team'
    : 'the background agents you spawned'
  return `Lists agents you can SendMessage to — ${who}, each row labeled with its status. Names are the address: send with \`SendMessage({to: "<name>", message: "..."})\`, copying the name exactly as a row prints it. A finished agent still answers — a send resumes it from its transcript.`
}
