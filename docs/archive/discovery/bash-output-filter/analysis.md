# Analysis — o que já sabemos

## Problema

Sessões com agentes em CLIs como o claudin rodam dezenas de comandos shell por turno. Saídas como `git status`, `ls -la`, `npm install`, `docker ps`, `cargo test` carregam muito **lixo de formatação** que o modelo não usa pra raciocinar (permissões, owners, timestamps de download, banners, ANSI escapes, linhas de progresso). Esse lixo:

1. Consome tokens de input em todo turno seguinte (a saída fica no histórico).
2. Mata o cache de prompt da Anthropic se variar entre chamadas (timestamps, IDs).
3. Empurra o turno mais perto do limite de contexto e força compaction prematura.

A tabela do rtk (README) cita **60-90% de redução** nos comandos cobertos. Mesmo descontando otimismo de marketing, qualquer redução >30% nos top-10 já paga o custo do projeto.

## Estado atual do claudin

### `toolResultSummarizer` (`src/agent/tools/toolResultSummarizer.ts`)

- **Reativo por threshold**: Bash=8KB, Grep=6KB, Read=10KB, WebFetch=12KB, Glob=3KB, Agent=8KB, MCP=8KB.
- **Agnóstico ao comando**: só decide pelo `toolName`. Não sabe se foi `git status` ou `cat huge.log`.
- **Per-tool strategies**: bash usa janela de erros + colapso de runs idênticos + colapso por dígitos (`summarizeBashOutput` linha 393). Grep agrupa matches. WebFetch faz strip de HTML. Read/Agent/MCP fazem head+tail.
- **Wrap em marker**: `<tool-result-summary tool="..." original="..." kept="..." strategy="...">`.
- **Plugado em**: `src/agent/tools/toolResultStorage.ts:225` (`processToolResultBlock`) — chokepoint provider-agnóstico, todo `tool_result` passa por ali.

### Lacunas identificadas

| Caso | Comportamento atual | Lacuna |
|---|---|---|
| `git status` com 4KB de output | Passthrough (abaixo de 8KB) | Saídas pequenas-mas-noisy passam intactas |
| `git diff` com 20KB | Head 40 linhas + tail 60 linhas | Estratégia ignora estrutura do diff (`--stat` + hunks) |
| `npm install` 50KB | Head/tail | Linhas de download dominariam o conteúdo "útil" |
| `docker ps` 6KB | Passthrough | Colunas largas com IDs e timestamps preservadas |
| `ls -la` 12KB | Head/tail | Formato `drwxr-xr-x ... 16:18 file` em vez de compact tree |

## Prior art: rtk

### Arquitetura

rtk é um proxy CLI: usuário roda `rtk git status` em vez de `git status`. Dois mecanismos coexistem:

#### 1. Filtros nativos em Rust (~40 módulos em `src/cmds/*/`)

Para casos onde o filtro precisa **parsear** a saída e reformatá-la. Exemplos:

- `cmds/system/ls.rs` (471 linhas) — parse de `ls -la`, agrupa dirs, formata files com tamanho human-readable, sumário por extensão. ANTES: `drwxr-xr-x 2 user staff 64 Jan 1 12:00 src` → DEPOIS: `src/`.
- `cmds/git/git.rs` — `git diff` roda `--stat` primeiro e mostra o stat antes do diff compactado.
- `cmds/system/grep_cmd.rs`, `cmds/rust/cargo_cmd.rs`, `cmds/js/npm_cmd.rs`, etc.

#### 2. Pipeline declarativo TOML (~60 filtros em `src/filters/*.toml`)

Para comandos onde basta cortar/limitar. 8 estágios em ordem (`src/core/toml_filter.rs:1-26`):

```
1. strip_ansi           — remove ANSI escapes
2. replace              — regex line-by-line, encadeado
3. match_output         — short-circuit: se blob bate, retorna `message` (com `unless` p/ não engolir erro)
4. strip_lines_matching | keep_lines_matching  — RegexSet, mutuamente exclusivos
5. truncate_lines_at    — limita largura por linha
6. head_lines + tail_lines  — mantém topo + base com marker `... (N lines omitted)`
7. max_lines            — cap absoluto
8. on_empty             — mensagem se resultado ficou vazio
```

Exemplo (`filters/jq.toml`):

```toml
[filters.jq]
description = "Compact jq output — truncate large JSON results"
match_command = "^jq\\b"
strip_ansi = true
strip_lines_matching = ["^\\s*$"]
max_lines = 40
truncate_lines_at = 120

[[tests.jq]]
name = "short output passes through"
input = "{\n  \"name\": \"test\"\n}"
expected = "{\n  \"name\": \"test\"\n}"
```

### Lookup de filtros

Prioridade (primeiro casa vence):

1. `.rtk/filters.toml` — projeto-local, **com trust SHA-256** (`hooks/trust.rs`)
2. `~/.config/rtk/filters.toml` — user-global
3. Built-in — concatenado em build time via `build.rs`, embutido no binário com `include_str!`

### Trust de filtros de projeto (`src/hooks/trust.rs`)

Modelo "trust before load":

- Filtro de projeto não é carregado até o usuário aprovar.
- Aprovação grava SHA-256 em `~/.local/share/rtk/trusted_filters.json`.
- Mudança no conteúdo invalida o trust → re-review.
- Override `RTK_TRUST_PROJECT_FILTERS=1` para CI.

Razão (citação do código): "An attacker can commit this file to a public repo to control what an LLM sees — hiding malicious code, suppressing security scanner output, or rewriting command output entirely via `replace` and `match_output` primitives."

### Cláusula `unless` (anti-engolimento de erro)

`match_output` curto-circuita a saída inteira numa mensagem fixa, mas se `unless` também casar, o curto-circuito é skipado. Padrão típico:

```toml
[[filters.npm-install.match_output]]
pattern = "added \\d+ packages"
message = "✓ npm install ok"
unless = "(?i)\\b(error|warning|deprecated)\\b"
```

## Peças que claudin já tem (não precisam ser construídas)

| Peça | Onde | Pra que serve |
|---|---|---|
| Parser de comando bash | `src/platform/bash/commands.ts:265` (`splitCommand_DEPRECATED`) | Decompor `cd foo && git status -s` em verbos individuais |
| `strip-ansi` | `package.json` (já dep) | Remover ANSI escapes |
| `commandSemantics.ts` | `src/tools/BashTool/commandSemantics.ts:31-77` | Mapa "exit≠0 não é necessariamente erro" (grep/rg/find/diff/test) |
| Chokepoint de tool result | `src/agent/tools/toolResultStorage.ts:225` | Local provider-agnóstico onde plugar |
| Marker convention | `<tool-result-summary>` em `toolResultSummarizer.ts:28` | Padrão pro modelo entender que houve compactação |
| MCP approval dialog | `src/services/mcpServerApproval.tsx` | Análogo direto do trust do rtk |

## Pontos de integração no código

### Opção (a) — dentro de BashTool

Plugar em `BashTool.mapToolResultToToolResultBlockParam` (`src/tools/BashTool/BashTool.tsx:589`), entre o trim e a montagem do bloco. Tem `input.command` no escopo.

```ts
// pseudocódigo
const filtered = applyBashOutputFilter(input.command, processedStdout)
processedStdout = filtered.body  // ou cru se filtro não casou
```

**Pró:** summarizer fica command-agnóstico (testes existentes não quebram), filtro tem todo o contexto.
**Contra:** só atende Bash (mas é onde 95% do ganho está).

### Opção (b) — estender summarizer

Adicionar 2º arg opcional `command?: string` em `maybeSummarizeToolResult`, summarizer chama pré-filtro antes do threshold check.

**Pró:** centraliza em um único módulo.
**Contra:** mistura responsabilidades, força mudanças em todos os call sites de `processToolResultBlock`.

### Opção (c) — wrapper em processToolResultBlock

Aceitar `command` como meta opcional no `processToolResultBlock`, propagar.

**Pró:** uniforme.
**Contra:** mais call sites pra tocar.

**Inclinação inicial: (a)**, justificada pelo princípio claudin "no premature abstraction".

## Cadeia de processamento proposta

```
stdout cru
  ↓
applyBashOutputFilter(command, stdout)        [novo, command-aware, sempre tenta]
  ↓
maybeSummarizeToolResult(block, toolName)     [existente, threshold-based]
  ↓
maybePersistLargeToolResult(...)              [existente, disco]
```

Implicações:
- Filtro novo **ignora threshold** (sempre tenta), mas só engaja se há redução real (overhead do marker não pode comer o ganho).
- Summarizer continua atuando como rede de segurança em script custom ou outputs ainda grandes pós-filtro.
- Idempotência: filtro skipa se output já tem marker (`<persisted-output>`, `<tool-result-summary>`).

## Riscos conhecidos e mitigações

| Risco | Mitigação |
|---|---|
| Engolir stack trace | `unless` clause obrigatória nos `match_output`, default-deny em `is_error: true` |
| Output de script custom bate em filtro genérico | `match_command` ancorado em `^cmd\b`, não substring solta |
| JSON estruturado mutilado | Detect JSON antes de qualquer regex, passthrough (já fazemos em `summarizeBashOutput:395-403`) |
| `2>&1` esconde stderr no stdout filtrado | Filtros não rodam quando `is_error: true` |
| ReDoS via regex de user filter | Compilar com timeout? RegExp do JS não tem timeout nativo. `re2-wasm` ou size cap no input |
| Filtro de projeto malicioso | Trust dialog tipo MCP (ver `open-questions.md` decisão #3) |
| Manutenção de 100 filtros | Começar com 10, formato JSON pro user, PRs da comunidade pro built-in |
