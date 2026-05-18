// Dispatch table — caracterização da estrutura de subcomandos do Commander.
//
// Após 11g, os registros vivem em src/main/commands/*.ts (chamados via
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
  readonly source: string  // src/main/commands/<file>.ts
  readonly children?: readonly SubcommandSpec[]
}

export const DISPATCH_TABLE: readonly SubcommandSpec[] = [
  { name: 'mcp', source: 'src/main/commands/mcp.ts', children: [
    { name: 'serve', source: 'src/main/commands/mcp.ts' },
    { name: 'remove', source: 'src/main/commands/mcp.ts' },
    { name: 'list', source: 'src/main/commands/mcp.ts' },
    { name: 'get', source: 'src/main/commands/mcp.ts' },
    { name: 'add-json', source: 'src/main/commands/mcp.ts' },
    { name: 'add-from-claude-desktop', source: 'src/main/commands/mcp.ts' },
    { name: 'reset-project-choices', source: 'src/main/commands/mcp.ts' },
  ] },
  { name: 'server', featureGate: 'DIRECT_CONNECT', source: 'src/main/commands/server.ts' },
  { name: 'ssh', featureGate: 'SSH_REMOTE', source: 'src/main/commands/ssh.ts' },
  { name: 'open', featureGate: 'DIRECT_CONNECT', source: 'src/main/commands/open.ts' },
  { name: 'auth', source: 'src/main/commands/auth.ts', children: [
    { name: 'login', source: 'src/main/commands/auth.ts' },
    { name: 'status', source: 'src/main/commands/auth.ts' },
    { name: 'logout', source: 'src/main/commands/auth.ts' },
  ] },
  { name: 'plugin', aliases: ['plugins'], source: 'src/main/commands/plugin.ts', children: [
    { name: 'validate', source: 'src/main/commands/plugin.ts' },
    { name: 'list', source: 'src/main/commands/plugin.ts' },
    { name: 'marketplace', source: 'src/main/commands/plugin.ts', children: [
      { name: 'add', source: 'src/main/commands/plugin.ts' },
      { name: 'list', source: 'src/main/commands/plugin.ts' },
      { name: 'remove', aliases: ['rm'], source: 'src/main/commands/plugin.ts' },
      { name: 'update', source: 'src/main/commands/plugin.ts' },
    ] },
    { name: 'install', aliases: ['i'], source: 'src/main/commands/plugin.ts' },
    { name: 'uninstall', aliases: ['remove', 'rm'], source: 'src/main/commands/plugin.ts' },
    { name: 'enable', source: 'src/main/commands/plugin.ts' },
    { name: 'disable', source: 'src/main/commands/plugin.ts' },
    { name: 'update', source: 'src/main/commands/plugin.ts' },
  ] },
  { name: 'setup-token', source: 'src/main/commands/setupToken.ts' },
  { name: 'agents', source: 'src/main/commands/agents.ts' },
  { name: 'auto-mode', featureGate: 'TRANSCRIPT_CLASSIFIER', source: 'src/main/commands/autoMode.ts', children: [
    { name: 'defaults', source: 'src/main/commands/autoMode.ts' },
    { name: 'config', source: 'src/main/commands/autoMode.ts' },
    { name: 'critique', source: 'src/main/commands/autoMode.ts' },
  ] },
  { name: 'remote-control', aliases: ['rc'], featureGate: 'BRIDGE_MODE', source: 'src/main/commands/remoteControl.ts' },
  { name: 'assistant', featureGate: 'KAIROS', source: 'src/main/commands/assistant.ts' },
  { name: 'doctor', source: 'src/main/commands/doctor.ts' },
  { name: 'update', aliases: ['upgrade'], source: 'src/main/commands/update.ts' },
  { name: 'install', source: 'src/main/commands/install.ts' },
]
