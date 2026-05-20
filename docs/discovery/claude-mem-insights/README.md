# Discovery: Token-saving ideas from `claude-mem`

> **Status:** discovery aberto em 2026-05-19. Análise comparativa do projeto [`claude-mem`](https://github.com/alexnewman/claude-mem) (Apache-2.0, plugin externo do Claude Code via `@anthropic-ai/claude-agent-sdk`) buscando técnicas de economia de tokens aplicáveis ao Claudio.
> **Última atualização:** 2026-05-20 — reavaliação contra o código atual do Claudio (ver "Reavaliação 2026-05-20" abaixo). Original 2026-05-19: todos os arquivos verificados contra o código-fonte real do `claude-mem`; cada feature tem uma seção "Correções pós-verificação".

## Reavaliação 2026-05-20 — o que ainda faz sentido

Revisão dos 6 docs contra o código atual do Claudio (`src/memdir/`, `src/services/extractMemories/`, `src/tools/FileReadTool/`).

| Doc | Situação | Veredito |
|---|---|---|
| `smart-explore` | ✅ **Implementado** | Commit `90335e1` (#40): `FileReadTool` com `view='outline'`/`symbol=`/auto-outline + `GrepTool` modo `symbols`, via `scanSymbols`+`renderOutline`. Saiu a v1 regex-based (sem tree-sitter). |
| `progressive-memory-recall` | ⚠️ **Superado** | Premissa desatualizada. O Claudio já tem recall sob demanda: `findRelevantMemories` escaneia headers e o Sonnet seleciona ≤5 arquivos por query — já é O(K). A proposta (`MemorySearchTool` LLM-driven) virou redundante: o Claudio escolheu um *selector automático* em vez de uma tool que o modelo pode esquecer de chamar. Não construir a tool. |
| `structured-extraction` | ◐ **Parcial — 1 item vale** | Téc.3 (`tool_choice`/XML parser) é **N/A**: o `extractMemories` usa um forked agent que escreve `.md` direto via `FileWrite` — não há saída a parsear. Téc.4 (discard+ack, no-retry) **já feito**. Téc.1 (`concept` enum) tem valor marginal sem recall-por-filtro. **Único TODO barato e válido: téc.2 — skip-routine guidance** (não existe linha mandando pular trabalho de rotina). |
| `tiered-memory-rendering` | ◐ **Válido, baixa urgência** | Hoje: `MEMORY.md` (index) sempre + ≤5 arquivos completos. Falta o tier `summary` e o token budget. O cap de 5 já limita o custo; o truncamento cego do `MEMORY.md` só morde com 200+ memórias. |
| `folder-scoped-context` | ◐ **Válido, baixa prioridade** | Claudio não faz. O próprio doc já recomenda cautela máxima. Análise continua de pé. |
| `observation-dedup` | ⚠️ **Enfraquecido** | O `extractMemories` já passa o manifest das memórias existentes ao forked agent + instrução "não duplique, atualize". Dedup delegado ao agente. Level A (hash programático) é marginal; Level B (fuzzy) nunca foi do claude-mem. |

**Ação recomendada:** implementar só a *skip-routine guidance* (~5 linhas no prompt de extração). O resto está feito, superado, ou é baixa prioridade.

## Contexto

O `claude-mem` é um plugin side-car focado em **memória persistente com economia de contexto**, claim central de ~10× redução de tokens vs. transcript no contexto. Roda como daemon HTTP local + MCP server + skills + SQLite + ChromaDB. Não é um fork, é plugin.

Este discovery não propõe adotar o `claude-mem`. Propõe identificar **quais técnicas dele têm ganho de tokens real e poderiam ser portadas/adaptadas para o Claudio**, que já tem infra própria de memória (`src/memdir/`, `src/services/extractMemories/`).

## Escopo

Documentar apenas as técnicas com **ganho de tokens direto ou indireto mensurável**. Itens de pura latência (async extraction via worker daemon) ou organização (mode files JSON) ficaram de fora.

## Arquivos

| Arquivo | O que tem | Ganho esperado |
|---|---|---|
| [`smart-explore.md`](smart-explore.md) | Three-tool pattern (`search` / `unfold` / `outline`) para colapsar bodies de arquivos grandes em signatures. No claude-mem via shell-out ao CLI `tree-sitter` | Alto — direto no `FileReadTool` em arquivos > 100 LoC |
| [`progressive-memory-recall.md`](progressive-memory-recall.md) | 3-layer recall (`search` índice → `timeline` contexto → `get_observations` detalhe) sob demanda via tool, em vez de inject-everything no system prompt | Alto — escala O(K) vs O(N) com nº de memórias |
| [`structured-extraction.md`](structured-extraction.md) | Taxonomia fechada (`type` + `concept` enums) + skip-routine guidance + tool_choice estruturado + política discard+ack on parse fail | Médio — menos memórias ruidosas → menos contexto futuro |
| [`tiered-memory-rendering.md`](tiered-memory-rendering.md) | Two-tier rendering (linha compacta vs detalhe). NOTA: o token-budget com auto-degradação é proposta do Claudio — o claude-mem usa só contagem fixa | Médio — corta system prompt em sessões longevas |
| [`folder-scoped-context.md`](folder-scoped-context.md) | Auto-write de `CLAUDE.md` em subpastas a partir de `files_modified[]`/`files_read[]` das observações. Existe, opt-in, default OFF | Médio — contexto pago só quando o agente entra na pasta |
| [`observation-dedup.md`](observation-dedup.md) | Dedup de observações por hash de conteúdo + UNIQUE constraint (não há janela de tempo). Proposta de dedup fuzzy vai além do claude-mem | Baixo direto, médio cumulativo — evita inflar índice de memória |

## Antipadrões observados (NÃO copiar)

Anotados aqui para registro — coisas que o `claude-mem` faz e o Claudio deve evitar:

- **XML-em-texto + regex parser** para saída do memory agent (`src/sdk/parser.ts`). O próprio código documenta como dívida técnica (`parser.ts:5`, `TODO(#2233)`, admite que tool-use API seria melhor). Claudio pode pular essa fase histórica e ir direto a `tool_choice` / structured output.
- **Shell-out ao binário CLI `tree-sitter`** para o smart-file-read (`parser.ts:515`). Cria dependência de executável + pacotes de grammar em disco. Claudio deve usar `web-tree-sitter` (WASM, in-process) ou regex puro — ver [`smart-explore.md`](smart-explore.md).
- **ChromaDB como dependência** para vector search. Para Claudio, `sqlite-vec` (WASM, ~1 MB) cobre o mesmo caso sem subir processo separado. Note que mesmo no claude-mem o `HybridSearchStrategy` é um stub — o filtro estrutural via SQLite carrega o trabalho. Discussão em [`progressive-memory-recall.md`](progressive-memory-recall.md).
- **Enum dessincronizado de dados vs. prompt-guidance** — o `claude-mem` tem 8 `observation_types` nos dados mas o prompt diz "6". Single-source o enum. Ver [`structured-extraction.md`](structured-extraction.md).
- **Cliff cego de recência (90 dias)** no search semântico — esconde memória antiga. Memória `feedback`/`user` antiga ainda é válida; recência deve ser sinal de rank, não filtro duro.

## Discrepâncias encontradas na verificação

A leitura inicial (feita por inspeção rápida) tinha vários erros que a verificação contra o código corrigiu. Resumo — detalhes nas seções "Correções pós-verificação" de cada arquivo:

- **`progressive-memory-recall`**: a ordem das 3 camadas estava trocada. Real: `search` (índice) → `timeline` (contexto) → `get_observations` (detalhe).
- **`tiered-memory-rendering`**: o "token budget com auto-degradação" **não existe** no claude-mem — ele usa contagem fixa. O budget virou proposta nossa, não cópia.
- **`observation-dedup`** (era `dedup-window`): não há janela de 30s — é hash de conteúdo + UNIQUE constraint. As funções `collapseRuns`/`collapseDigitTemplates` não são do claude-mem (são do nosso próprio `bash-output-filter`).
- **`smart-explore`**: claude-mem faz shell-out ao CLI `tree-sitter`, não usa lib in-process; 24 grammars (não "25+"); line numbers das MCP tools estavam trocados.
- **`structured-extraction`**: `type` tem 8 valores (não 6); o cap "≤24 palavras" é do `subtitle`, não do `title`.

## Ordem de implementação sugerida

Por razão valor/esforço:

1. **`structured-extraction.md`** — skip-routine no prompt + enums fechados. Custo: ~50 linhas em `src/services/extractMemories/`. Ganho imediato em ruído de memórias.
2. **`smart-explore.md`** — v1 com regex por linguagem (sem tree-sitter). Maior ganho por dólar; reutiliza filosofia do `BashOutputFilter`.
3. **`progressive-memory-recall.md`** — `MemorySearchTool` MCP-like. Maior ganho potencial em sessões longevas; mais invasivo no fluxo de boot do REPL.
4. **`tiered-memory-rendering.md`** — token budget no renderer. Independente, baixo risco.
5. **`folder-scoped-context.md`** + **`observation-dedup.md`** — refinamentos cumulativos.

## Não-objetivos

- Não estamos avaliando adoção do `claude-mem` como plugin do Claudio.
- Não estamos propondo retrocompatibilidade com o schema de observação dele.
- Não estamos discutindo OAuth/ChatGPT/provider switching — isso o Claudio já tem.
