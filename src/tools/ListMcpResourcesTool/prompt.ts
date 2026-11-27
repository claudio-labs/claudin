export const LIST_MCP_RESOURCES_TOOL_NAME = 'ListMcpResourcesTool'

export const DESCRIPTION = `
Lists available resources from configured MCP servers.
Each resource object includes a 'server' field indicating which server it's from.

Usage examples:
- List all resources from all servers: \`listMcpResources\`
- List resources from a specific server: \`listMcpResources({ server: "myserver" })\`
`

export const PROMPT = `
List available resources from configured MCP servers.
Each returned resource will include all standard MCP resource fields plus a 'server' field 
indicating which server the resource belongs to.
An entry with a 'uriTemplate' instead of a 'uri' is a resource template: fill in its
variables and read the resulting URI with ReadMcpResourceTool.

Parameters:
- server (optional): The name of a specific MCP server to get resources from. If not provided,
  resources from all servers will be returned.
`
