import React from 'react'
import { Link, Text } from 'src/terminal/ink.js'

export const MCP_DOCS_URL = 'https://www.claudiolabs.ai/docs/mcp'

export function MCPServerDialogCopy(): React.ReactNode {
  return (
    <Text>
      MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the{' '}
      <Link url={MCP_DOCS_URL}>MCP documentation</Link>.
    </Text>
  )
}
