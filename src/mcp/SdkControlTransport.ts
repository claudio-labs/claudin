import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export type SendMcpMessageCallback = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>

/**
 * A client transport for a server the SDK host runs in its own process: each
 * message goes out over the stream-json control channel, and the host's
 * answer comes back as the reply.
 */
export class SdkControlClientTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  readonly #serverName: string
  readonly #forward: SendMcpMessageCallback
  #closed = false

  constructor(serverName: string, sendMcpMessage: SendMcpMessageCallback) {
    this.#serverName = serverName
    this.#forward = sendMcpMessage
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) throw new Error('Transport is closed')
    const reply = await this.#forward(this.#serverName, message)
    this.onmessage?.(reply)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.onclose?.()
  }
}
