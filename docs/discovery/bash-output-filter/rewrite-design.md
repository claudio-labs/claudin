# Design: Command Rewrite no claudio

> Documenta **como tecnicamente** plugar a estratégia Rewrite (R) no fluxo do BashTool.
> Decisão: Q2 do open-questions = ✅ aceita Rewrite na v1.

## O problema

**Quando** mutar o comando? Antes de executar (claro). **Onde** no código? **Como** sinalizar pro modelo que houve rewrite? **Como** tratar edge cases (pipes, redirecionamento, flags que conflitam)?

## Fluxo atual do BashTool (sem rewrite)

```
1. Agent chama BashTool com input.command = "git log -10"
2. checkPermissions(input, context)
3. BashTool.call(input, ...) → runShellCommand({ input, ... })
4. Output capturado em result.stdout
5. mapToolResultToToolResultBlockParam(...) formata
6. processToolResultBlock(...) → maybeSummarizeToolResult(...) → output ao modelo
```

Pontos de integração possíveis:

- **(a)** Entre passo 1 e 2 (mutar `input.command` antes do permission check)
- **(b)** Entre passo 2 e 3 (depois de permitir, antes de executar)
- **(c)** Dentro do `runShellCommand` (como argumento)
- **(d)** Pós-execução, no resultado — **NÃO funciona pra rewrite** (output já existe)

**Recomendação: (b)** — entre permission check e execução. Razões:
- (a) seria perigoso — user aprovou `git log -10`, não `git log --oneline -30`. Permission deve ser sobre comando ORIGINAL.
- (c) acopla demais com runShellCommand internals.
- (b) é cirúrgico: 5 linhas em `BashTool.call()`.

## Shape do código proposto

### 1. Estender `FilterSpec` com `rewriteCommand`

```ts
// validation/pipeline.ts (futuro src/outputFilter/Bash/pipeline.ts)
export interface FilterSpec {
  name: string
  matchCommand: RegExp
  matchCommandReject?: RegExp

  /**
   * NOVO: rewrite the command before execution.
   * Returns the new command, or null to skip rewrite (apply pipeline only).
   * Receives the parsed command + original args so it can preserve user flags.
   */
  rewriteCommand?: (input: { command: string; verb: string; args: string[] }) => string | null

  // ...resto do pipeline (P/M/D) continua igual
  stripAnsi?: boolean
  // ...
}
```

### 2. Filter exemplo: `git log` força `--oneline`

```ts
const gitLogFilter: FilterSpec = {
  name: 'git-log',
  matchCommand: /^git(\s+-[^\s]+)*\s+log\b/,
  matchCommandReject: /--oneline|--format=|--pretty=|-p\b|--patch|-1\b|-2\b|-3\b|-4\b|-5\b/,
  // ↑ reject quando user já especificou formato OU pediu N pequeno (quer ver body)

  rewriteCommand: ({ args }) => {
    // Preserve user args, just append --oneline + cap
    const hasLimit = args.some(a => /^-\d+$|^-n\d+$|^--max-count=/.test(a))
    const cap = hasLimit ? '' : ' -30'
    return `git log --oneline${cap} ${args.filter(a => a !== 'log').join(' ')}`.trim()
  },

  // pipeline pós-rewrite (no-op porque --oneline já é compacto)
}
```

### 3. Hook em `BashTool.call()`

Localização: `src/tools/BashTool/BashTool.tsx:634` (`async call(input, ...)`)

```ts
async call(input: BashToolInput, toolUseContext, _canUseTool, parentMessage, onProgress) {
  // ... handling de _simulatedSedEdit etc ...

  // === NOVO: REWRITE STAGE ===
  let actualCommand = input.command
  let rewriteInfo: { from: string; to: string; filterName: string } | null = null

  if (!isEnvTruthy(process.env.CLAUDIO_DISABLE_BASH_OUTPUT_FILTER)) {
    const filter = findMatchingFilter(input.command)
    if (filter?.rewriteCommand) {
      const parsed = parseBashCommand(input.command)  // existing helper
      const newCommand = filter.rewriteCommand(parsed)
      if (newCommand && newCommand !== input.command) {
        actualCommand = newCommand
        rewriteInfo = {
          from: input.command,
          to: newCommand,
          filterName: filter.name,
        }
        logForDebugging(`bashOutputFilter: rewrote "${input.command}" → "${newCommand}" via filter "${filter.name}"`, { level: 'info' })
      }
    }
  }
  // === FIM NOVO ===

  const stdoutAccumulator = new EndTruncatingAccumulator()
  // ... continua como está, mas usando actualCommand ...

  const commandGenerator = runShellCommand({
    input: { ...input, command: actualCommand },  // ← passa o reescrito
    abortController,
    // ...
  })

  // ... loop como está ...

  // Quando montar o resultado:
  return {
    interrupted: wasInterrupted,
    stdout: result.stdout,
    stderr: stderrForShellReset,
    rewriteInfo,  // ← propaga pro mapToolResult
    // ...
  }
}
```

### 4. Sinalizar pro modelo via marker no output

`mapToolResultToToolResultBlockParam` (linha 563) já adiciona contexto. Estender:

```ts
mapToolResultToToolResultBlockParam({
  interrupted, stdout, stderr, rewriteInfo, /* ... */
}, toolUseID): ToolResultBlockParam {
  // ... handling normal ...

  let processedStdout = normalizedStdout

  // === NOVO: marker de rewrite ===
  if (rewriteInfo) {
    processedStdout =
      `<bash-output-rewritten filter="${rewriteInfo.filterName}" original="${escapeXml(rewriteInfo.from)}" actual="${escapeXml(rewriteInfo.to)}">\n` +
      processedStdout
    // O fechamento do tag não é necessário — é só metadata pro modelo
  }

  // ... resto continua ...
}
```

**Por que NÃO fechar a tag**: minimiza tokens. O modelo entende que `<bash-output-rewritten ...>` é metadata e o resto é o output. Mesmo padrão usado por `<persisted-output>` etc.

### 5. Ordem do filter pipeline pós-rewrite

```
1. parse comando user
2. matchCommand + matchCommandReject — decidir se filter aplica
3. rewriteCommand (se filter tem) — gera novo comando
4. permission check sobre comando ORIGINAL (preservar user intent na permissão)
5. executa actualCommand
6. captura stdout/stderr
7. pipeline P (stripAnsi → replace → match_output → ...) sobre output
8. resultado + marker rewrite
```

**Crucial:** rewrite acontece ANTES de executar; pipeline P/M/D acontece DEPOIS. Não são alternativas — podem combinar.

Exemplo `cargo build` (caminho agressivo):
- Rewrite: `cargo build` → `cargo build --message-format=json`
- Pipeline pós: parse JSON, reformat compact

## Edge cases a tratar

### Compound commands (`&&`, `|`, `;`)

```
git log -10 | wc -l        # rewrite só primeiro componente?
cd foo && git log -10      # mesmo
git log -10 ; date         # mesmo
```

claudio já tem `splitCommandWithOperators` em `src/utils/bash/commands.ts`. Approach:
- Rewrite **só o componente que casa**, recompõe o pipe
- Se output do `git log` vai pra `wc -l`, rewrite ainda funciona (oneline tem N linhas vs verbose tem M linhas — wc count muda!)

**Decisão:** **NÃO REWRITE** quando o comando é parte de pipe (`|`) ou compound (`&&`/`;`). Por quê:
- User provavelmente está fazendo algo específico (counting, parsing)
- Rewrite muda count/parse target

Detecção: se `splitCommandWithOperators(command).length > 1`, skip rewrite.

### Heredocs e quoting

```
git log -10 --grep="hello world"
git log -10 --pretty='%h %s'
```

Já temos parsing em `src/utils/bash/`. Rewrite preserva args do user. Não tocar em `--grep`, `--pretty` etc.

### Flags que invalidam o rewrite

```
git log -10 -p              # user quer diff junto — NÃO forçar oneline
git log --no-decorate       # user quer formato custom
```

`matchCommandReject` cobre. Lista pra cada filter:
- `git log` reject: `-p`, `--patch`, `--pretty=`, `--format=`, `--graph`, `--oneline` (já)
- `git status` reject: `--porcelain`, `--short`, `-s`, `--json`, `-z`
- `ruff check` reject: `--output-format=` (qualquer)
- `cargo build` reject: `--message-format=`

### `is_error: true` (exit code ≠ 0)

Decisão: **rewrite ainda aplica**, pipeline filter NÃO aplica em is_error. Por quê:
- Exit ≠ 0 com rewrite ainda nos dá output do comando reescrito (ex: `git log --oneline` falhou? user precisa do erro original)
- Mas o erro do comando reescrito É o mesmo erro do comando original
- Se user precisa de mais detalhe, pode rerodar com `CLAUDIO_DISABLE_BASH_OUTPUT_FILTER=1`

Alternativa: **rewrite skip em is_error retroativamente** — rerodar comando original. Desperdício de tempo. Não vale.

### Permissions

`checkPermissions` em `BashTool.tsx:547` recebe `input` (o original). Permissão é sobre o que **user/agent quis fazer**, não sobre o reescrito.

```ts
async checkPermissions(input, context): Promise<PermissionResult> {
  return bashToolHasPermission(input, context)  // ← input ORIGINAL aqui
}
```

Não tocar. User aprova `git log -10`, sistema reescreve, executa. Se `git log -10` é proibido, rewrite não muda isso.

### Cache de prompt (Anthropic)

Crítico: rewrite deve ser **determinístico**. Se o mesmo `input.command` gera diferentes `actualCommand` entre chamadas, prompt cache quebra (output muda).

Filtros R devem:
- Não usar timestamps no rewrite
- Não usar random/UUID
- Não depender de variáveis de ambiente que mudam

## Configuração

### Env vars

- `CLAUDIO_DISABLE_BASH_OUTPUT_FILTER=1` — desliga TUDO (rewrite + pipeline)
- `CLAUDIO_BASH_FILTER_DEBUG=1` — log inline do que foi reescrito (pra debug do user)
- `CLAUDIO_DISABLE_REWRITE=1` — desliga só rewrite (pipeline continua) ⭐ **opt-out granular**

### Settings.json

```jsonc
{
  "bashOutputFilter": {
    "enabled": true,
    "rewriteEnabled": true,    // ← granular toggle pro rewrite
    "filters": []              // user-defined filters (futuro)
  }
}
```

## Visibilidade pro modelo + user

### O modelo vê (sempre)

```
<bash-output-rewritten filter="git-log" original="git log -10" actual="git log --oneline -30">
abc1234 fix(api): ...
def5678 feat(cli): ...
... (28 mais)
```

Modelo entende que rewrite aconteceu, output é diferente do que pediu. Pode rerodar com flag específica se precisar.

### O user vê (TUI)

Footer discreto na render do tool result em [`BashToolResultMessage.tsx`](src/tools/BashTool/BashToolResultMessage.tsx):

```
[git-log filter rewrote command: --oneline -30]
abc1234 fix(api): ...
...
```

## Custo de implementação

Mudanças concretas:

| Arquivo | Mudança | LoC |
|---|---|---|
| `src/outputFilter/Bash/pipeline.ts` (NEW) | Pipeline + types + rewriteCommand | ~300 |
| `src/outputFilter/Bash/filters/index.ts` (NEW) | Built-in filter specs | ~250 |
| `src/tools/BashTool/BashTool.tsx` | Hook em `call()` | ~15 |
| `src/tools/BashTool/BashTool.tsx` | Marker em `mapToolResult` | ~10 |
| `src/utils/config.ts` | Toggle `bashOutputFilter` | ~5 |
| Tests | Cobertura dos 6 filtros R + safety | ~400 |
| **Total** | | **~980 LoC** |

## Filters R recomendados pra v1

Baseado na matriz:

1. **`git-log`** → `--oneline -30` (preserva user `-N`/`--grep`/etc)
2. **`git-status`** → `--porcelain --branch` (preserva flags)
3. **`ruff check`** → `--output-format=json` + parse + reformat
4. **`cargo build/check`** → `--message-format=json` + parse (opcional, ROI já alto sem)
5. **`go test`** → `-json` + parse (opcional, P+M já dá 82%)
6. **`gh pr/issue/run list`** → `--json <fields>` + format
7. **`kubectl get`** → `-o json` + parse + reformat (Tier 1.5 — instalar)

## Trade-off final reconhecido

**Modelo perde fidelidade ao output cru** que pediu. Mitigação:
- Marker explícito `<bash-output-rewritten>` torna a transformação visível
- `CLAUDIO_DISABLE_REWRITE=1` opt-out granular
- Filters R só ativam quando ROI ≥ 50pp acima do P-only (não vale a pena rewrite por 10pp)

## Próximos passos concretos

1. **Spec da v1 em `docs/plans/bash-output-filter.md`** — usar este doc como input
2. **Adicionar `rewriteCommand` ao pipeline** validador atual pra testar fluxo end-to-end com 1 filter (git-log) antes de codar
3. **Decidir lista final** de filters R (proponho 5: git-log, git-status, ruff, gh, kubectl-get)

---

## Resumo de uma linha

**Rewrite no claudio = mutar `input.command` em `BashTool.call()` antes de `runShellCommand`, propagando `rewriteInfo` pro `mapToolResult` que injeta marker `<bash-output-rewritten>` no output.** ~25 LoC no BashTool + filter specs.
