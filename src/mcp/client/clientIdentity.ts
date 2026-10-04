import { PRODUCT_URL } from 'src/shared/constants/product.js'

/**
 * How Claudin introduces itself to an MCP server. The `name` stays
 * `claude-code` because servers key behaviour on it.
 */
export function mcpClientIdentity(): {
  name: string
  title: string
  version: string
  description: string
  websiteUrl: string
} {
  return {
    name: 'claude-code',
    title: 'Claudin',
    version: MACRO.VERSION ?? 'unknown',
    description: "Anthropic's agentic coding tool",
    websiteUrl: PRODUCT_URL,
  }
}
