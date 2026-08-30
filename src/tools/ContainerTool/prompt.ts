export const CONTAINER_TOOL_NAME = 'Container'

/**
 * Registered with `shouldDefer: true`, so this string is NOT in the system
 * prompt of every request — `ToolSearch` pulls it only once the model reaches
 * for containers. That is what makes a ~29-op surface affordable at all.
 *
 * It is still not free: once surfaced it sits in context for the rest of the
 * session, so the budget is one line per op and prose only where the behaviour
 * is genuinely non-obvious. `prompt.test.ts` pins the size.
 */
export const DESCRIPTION = `Run docker and docker compose against THIS project's stack, and get back a summarized result instead of raw output.

Scope: every op targets the compose project rooted at the current directory, matched on the compose \`working_dir\` label. A container started with a plain \`docker run\` carries no compose labels and is therefore invisible here — its absence from \`ps\` does not mean it is not running.

Read — \`ps\` (containers, state, health, ports), \`inspect\`, \`logs\`, \`stats\`, \`top\`, \`port\`, \`images\`, \`df\`, \`config\`, \`events\`.
Lifecycle — \`up\`, \`down\`, \`start\`, \`stop\`, \`restart\`, \`pause\`, \`unpause\`, \`pull\`, \`push\`.
Images — \`build\`, \`tag\`, \`history\`.
Interact — \`exec\`, \`run\`, \`cp\`.
Wait — \`wait\`.
Destructive — \`rm\`, \`rmi\`, \`prune\`.

\`wait\` blocks until a service reaches a state (healthy, running or exited). Use it instead of polling \`curl\` in a \`sleep\` loop. When the service declares no healthcheck it fails fast saying so, rather than hanging to the timeout.

\`logs\` returns the errors it extracted over a bounded \`since\` window, with stack traces kept whole — not the raw tail. \`follow\` streams in the background instead of returning once.

\`build\` covers both \`docker build\` and \`docker compose build\`. It reports the cached/rebuilt layer split, reports a fully warm build as up to date with nothing rebuilt, and on failure returns the failing step's own output rather than the tail of an interleaved log. \`background: true\` returns immediately and reports on completion — use it for a slow Dockerfile instead of blocking the turn.

\`exec\` runs a command inside a container. It is permission-checked exactly like the equivalent Bash command, as is every other mutating op, so your existing \`Bash(docker …)\` rules apply unchanged.

\`prune\`, \`rm\`, \`rmi\` and \`down\` with \`volumes: true\` destroy data and always prompt.

A failing op comes back as its raw output with a one-line diagnosis prepended, never as a summary.`
