#!/usr/bin/env bun
/**
 * A stdio MCP server with one tool, `allow`, for `--permission-prompt-tool`
 * in headless A/B runs (`tool-gaps-ab.ts`).
 *
 * Under `--dangerously-skip-permissions` the only calls that still ask are the
 * ones that need a user (`requiresUserInteraction`): ExitPlanMode, which this
 * approves as a user would, and AskUserQuestion, which it declines with "no
 * user here, decide yourself". Anything else that reaches it is allowed, as
 * the bypass would have.
 *
 * Newline-delimited JSON-RPC, no SDK: initialize, tools/list, tools/call, ping.
 */

const TOOL = {
  name: 'allow',
  description: 'Permission prompt for headless benchmark runs.',
  inputSchema: {
    type: 'object',
    properties: {
      tool_name: { type: 'string' },
      input: { type: 'object' },
      tool_use_id: { type: 'string' },
    },
    required: ['tool_name', 'input'],
  },
}

const NO_USER =
  'No user is available in this session. Decide with your best judgment and continue without asking.'

/** The decision the permission prompt returns, as the JSON text the CLI parses. */
export function decide(toolName: string): Record<string, unknown> {
  if (toolName === 'AskUserQuestion') return { behavior: 'deny', message: NO_USER }
  return { behavior: 'allow', updatedInput: {} }
}

type Request = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

export function respond(request: Request): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: request.id, result })
  switch (request.method) {
    case 'initialize':
      return reply({
        protocolVersion: (request.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'approver', version: '1.0.0' },
      })
    case 'tools/list':
      return reply({ tools: [TOOL] })
    case 'tools/call': {
      const args = (request.params?.arguments ?? {}) as { tool_name?: string }
      return reply({ content: [{ type: 'text', text: JSON.stringify(decide(String(args.tool_name ?? ''))) }] })
    }
    case 'ping':
      return reply({})
    default:
      // Notifications carry no id and get no answer.
      if (request.id === undefined) return null
      return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } }
  }
}

if (import.meta.main) {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
      if (!line) continue
      try {
        const answer = respond(JSON.parse(line) as Request)
        if (answer) process.stdout.write(`${JSON.stringify(answer)}\n`)
      } catch {
        // A line that is not JSON-RPC is ignored, as the transport allows.
      }
    }
  })
}
