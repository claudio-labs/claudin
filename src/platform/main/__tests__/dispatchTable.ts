// Dispatch table — caracterização da estrutura de subcomandos do Commander.
//
// Após 11g, os registros vivem em src/platform/main/commands/*.ts (chamados via
// registerSubcommands.ts). A tabela abaixo é a "expectativa": o test
// `dispatch table matches registered Commander subcommands` em
// bootSnapshot.test.ts faz scan de `.command('name'` nos arquivos
// reais e cruza com esta lista, falhando se divergir.
//
// Atualizar deliberadamente quando um subcomando for adicionado/removido.

export type SubcommandSpec = {
  readonly name: string
  readonly aliases?: readonly string[]
  readonly featureGate?: string
  readonly source: string  // src/platform/main/commands/<file>.ts
  readonly children?: readonly SubcommandSpec[]
}

export const DISPATCH_TABLE: readonly SubcommandSpec[] = [
  { name: 'mcp', source: 'src/platform/main/commands/mcp.ts', children: [
    { name: 'serve', source: 'src/platform/main/commands/mcp.ts' },
    { name: 'remove', source: 'src/platform/main/commands/mcp.ts' },
    { name: 'list', source: 'src/platform/main/commands/mcp.ts' },
    { name: 'get', source: 'src/platform/main/commands/mcp.ts' },
    { name: 'add-json', source: 'src/platform/main/commands/mcp.ts' },
    { name: 'add-from-claude-desktop', source: 'src/platform/main/commands/mcp.ts' },
    { name: 'reset-project-choices', source: 'src/platform/main/commands/mcp.ts' },
  ] },
  { name: 'server', featureGate: 'DIRECT_CONNECT', source: 'src/platform/main/commands/server.ts' },
  { name: 'ssh', featureGate: 'SSH_REMOTE', source: 'src/platform/main/commands/ssh.ts' },
  { name: 'open', featureGate: 'DIRECT_CONNECT', source: 'src/platform/main/commands/open.ts' },
  { name: 'auth', source: 'src/platform/main/commands/auth.ts', children: [
    { name: 'login', source: 'src/platform/main/commands/auth.ts' },
    { name: 'status', source: 'src/platform/main/commands/auth.ts' },
    { name: 'logout', source: 'src/platform/main/commands/auth.ts' },
  ] },
  { name: 'plugin', aliases: ['plugins'], source: 'src/platform/main/commands/plugin.ts', children: [
    { name: 'validate', source: 'src/platform/main/commands/plugin.ts' },
    { name: 'list', source: 'src/platform/main/commands/plugin.ts' },
    { name: 'marketplace', source: 'src/platform/main/commands/plugin.ts', children: [
      { name: 'add', source: 'src/platform/main/commands/plugin.ts' },
      { name: 'list', source: 'src/platform/main/commands/plugin.ts' },
      { name: 'remove', aliases: ['rm'], source: 'src/platform/main/commands/plugin.ts' },
      { name: 'update', source: 'src/platform/main/commands/plugin.ts' },
    ] },
    { name: 'install', aliases: ['i'], source: 'src/platform/main/commands/plugin.ts' },
    { name: 'uninstall', aliases: ['remove', 'rm'], source: 'src/platform/main/commands/plugin.ts' },
    { name: 'enable', source: 'src/platform/main/commands/plugin.ts' },
    { name: 'disable', source: 'src/platform/main/commands/plugin.ts' },
    { name: 'update', source: 'src/platform/main/commands/plugin.ts' },
  ] },
  { name: 'setup-token', source: 'src/platform/main/commands/setupToken.ts' },
  { name: 'agents', source: 'src/platform/main/commands/agents.ts' },
  { name: 'auto-mode', featureGate: 'TRANSCRIPT_CLASSIFIER', source: 'src/platform/main/commands/autoMode.ts', children: [
    { name: 'defaults', source: 'src/platform/main/commands/autoMode.ts' },
    { name: 'config', source: 'src/platform/main/commands/autoMode.ts' },
    { name: 'critique', source: 'src/platform/main/commands/autoMode.ts' },
  ] },
  { name: 'remote-control', aliases: ['rc'], featureGate: 'BRIDGE_MODE', source: 'src/platform/main/commands/remoteControl.ts' },
  { name: 'assistant', featureGate: 'KAIROS', source: 'src/platform/main/commands/assistant.ts' },
  { name: 'doctor', source: 'src/platform/main/commands/doctor.ts' },
  { name: 'update', aliases: ['upgrade'], source: 'src/platform/main/commands/update.ts' },
  { name: 'install', source: 'src/platform/main/commands/install.ts' },
  { name: 'workflow', featureGate: 'AGENT_WORKFLOWS', source: 'src/platform/main/commands/workflow.ts', children: [
    { name: 'run', source: 'src/platform/main/commands/workflow.ts' },
    { name: 'watch', source: 'src/platform/main/commands/workflow.ts' },
  ] },
]
