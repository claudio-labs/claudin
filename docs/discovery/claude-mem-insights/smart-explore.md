# Smart Explore — outline / unfold / search

> **Fonte:** `claude-mem` repo, `src/services/smart-file-read/parser.ts` (1042 LoC), `src/services/smart-file-read/search.ts`, `src/servers/mcp-server.ts`, `plugin/skills/smart-explore/SKILL.md`.
> **Verificado contra o repo em 2026-05-19** — ver "Correções pós-verificação" no fim.

## Ideia

Três MCP tools que substituem `Read` em arquivos longos. O agente vê primeiro a **estrutura** (signatures), depois expande só o símbolo que importa.

| Tool | mcp-server.ts | Input | Output | Custo típico |
|---|---|---|---|---|
| `smart_search` | :671 | `query`, `path?`, `max_results=20`, `file_pattern?` | Símbolos rankeados com signature + JSDoc + linha + folded view dos arquivos hosts | ~2-6k tok |
| `smart_unfold` | :708 | `file_path`, `symbol_name` | Source completo de UM símbolo (com JSDoc/decorators/comentários acima, prefixado por locator `📍 path Lx-Ly`). Em miss, devolve lista de símbolos disponíveis | ~400-2.1k tok |
| `smart_outline` | :752 | `file_path` | Skeleton estrutural: só signatures, body colapsado | ~1-2k tok |

`CodeSymbol.kind` é enum fechado (`parser.ts:15`, interface em `:13-23`): `function | class | method | interface | type | const | variable | export | struct | enum | trait | impl | property | getter | setter | mixin | section | code | metadata | reference`.

## Arquitetura do parser — IMPORTANTE para portar

O `claude-mem` **não usa as bindings nativas do tree-sitter nem WASM**. Ele faz **shell-out para o binário CLI `tree-sitter`**:

- `parseFile` (`parser.ts:762`) / `parseFilesBatch` (`:804`) escrevem o source num temp file e chamam `tree-sitter query -p <grammar> <queryFile> <sourceFile...>` via `execFileSync` (`:515`, timeout 30s).
- A saída humana do CLI é raspada por regex (`parseMultiFileQueryOutput`, `:524`).
- Resolução do binário (`getTreeSitterBin`, `:470`): tenta `tree-sitter-cli/package.json`, cai para `tree-sitter` no `$PATH`.
- Usa arquivos de query `.scm` escritos num temp dir (`getQueryFile`, `:455`).

**Gotcha de portabilidade:** parsing depende do executável `tree-sitter` + os pacotes de grammar resolvíveis em disco. NÃO é uma lib in-process. Portar = ou bundlar CLI + grammars, ou aceitar dependência de `$PATH`. Para o Claudin (política de evitar `.node` e deps externas), isto é exatamente o que **não** se quer copiar — ver proposta v2 abaixo.

**Trick de performance:** `parseFilesBatch` (`:804`) agrupa arquivos por linguagem e dispara **uma** chamada `tree-sitter query` por linguagem com todos os arquivos como args. Um spawn de processo por linguagem, não por arquivo.

## Heurística outline-vs-body

**Não é automática por threshold.** Nenhum tool mede tamanho de arquivo. Quem decide é o LLM, guiado pela skill:

> "For code files over ~100 lines, prefer smart_outline + smart_unfold over Read" — `SKILL.md:92`

Suporte: `SKILL.md:88` manda usar `Read` para "small files under ~100 lines, non-code files"; `SKILL.md:8` diz "This skill overrides your default exploration behavior". A regra dos `~100 lines` é texto em linguagem natural — pura engenharia de prompt.

Limites do engine são só defensivos (`search.ts`):

- `MAX_FILE_SIZE = 512 KB` (`search.ts:40`) — arquivos maiores skipados em `safeReadFile` (`:92`); zero-byte também skipados (`:93`)
- Skip de binários: null byte nos primeiros **1000 caracteres** da string UTF-8 (`search.ts:97`)
- `maxDepth = 20` no walker (`search.ts:61,133`)
- `IGNORE_DIRS` (`search.ts:33-38`): `node_modules, .git, dist, build, .next, __pycache__, .venv, venv, env, .env, target, vendor, .cache, .turbo, coverage, .nyc_output, .claude, .smart-file-read` — além de **qualquer entrada começando com `.`** (`:73`)
- Timeout do `tree-sitter query`: 30s (`parser.ts:515`)

## Linguagens suportadas

`GRAMMAR_PACKAGES` (`parser.ts:183-209`) bundla **24 grammars**: javascript, typescript, tsx, python, go, rust, ruby, java, c, cpp, kotlin, swift, php, elixir, lua, scala, bash, haskell, zig, css, scss, toml, yaml, sql, markdown.

(A tabela "Bundled Languages" do `SKILL.md:153-164` lista só 10 — o doc deles subdimensiona o que o código realmente bundla.)

Grammars custom via `<projectRoot>/.claude-mem.json` (`loadUserGrammars`, `parser.ts:112`). **Cuidado:** o exemplo do `SKILL.md:172-181` mostra forma *flat* errada (`".sol": "tree-sitter-solidity"`). O código exige forma *aninhada* chaveada por linguagem (`parser.ts:138-155`):

```json
{ "grammars": { "solidity": { "package": "tree-sitter-solidity", "extensions": [".sol"], "query": "optional/path.scm" } } }
```

## Aplicabilidade no Claudin

**Onde dói hoje:** `FileReadTool` sempre devolve arquivo inteiro (ou range manual via `offset`/`limit`). Arquivos grandes do próprio repo — `openaiShim.ts` (~2.2k LoC), `QueryEngine.ts`, `providerConfig.ts` (~925 LoC) — custam muito quando o agente quer ver uma função específica.

**Proposta v1 (regex-based, sem dependência nova):**

- `SmartOutlineTool` — varre arquivo com regex por linguagem (`^(export )?(async )?function|^class |^interface |^type |^const .* = |^def |^fn |^struct |^impl`), devolve só signatures + JSDoc imediatamente acima
- `SmartUnfoldTool` — recebe nome do símbolo, faz match na regex, devolve do início da assinatura até o `}` balanceado (ou indent-based para Python/YAML)
- Custo: ~300 LoC + tests. Mesma filosofia do `BashOutputFilter`: heurística por linguagem, falha graciosa devolvendo `Read` normal
- Gate por `feature('SMART_FILE_READ')` desligado por default até validação

**Proposta v2 (tree-sitter via WASM — divergir do claude-mem aqui):**

- `web-tree-sitter` (puro WASM, sem `.node` addon, **sem shell-out para CLI** — o claude-mem faz shell-out, que o Claudin deve evitar)
- Custo: +~2 MB no bundle, parsing real ao invés de regex
- Cobre as 24 linguagens com gramáticas WASM pré-compiladas
- Faz sentido depois que v1 provar o caso

**`SmartSearchTool` é deliberadamente diferente do `GrepTool`:**

| | `GrepTool` (existente) | `SmartSearchTool` (proposto) |
|---|---|---|
| Input | regex de texto | nome de símbolo + kind opcional |
| Output | linhas raw | signature + JSDoc + linha |
| Use case | "achar todos os usos de `logError`" | "onde está a função `parseConfig`?" |

Ambos coexistem. `GrepTool` continua para texto livre/imports/strings.

## Insights da implementação

- **Fail-open em tudo:** grammar ausente → símbolos vazios com `foldedTokenEstimate: 50`; falha do tree-sitter → `Map` vazio. `smart_outline`/`smart_unfold` degradam para "Could not parse"; `smart_search` ainda funciona via match de texto/path.
- **Nesting por range de linha, não por AST:** `buildSymbols` (`parser.ts:747-757`) re-parenta símbolos em classes/structs/impls comparando `lineStart`/`lineEnd` — barato, mas pode mis-nestar com formatação incomum.
- **Markdown tem tratamento próprio:** árvore de headings, code blocks como símbolos, frontmatter YAML como símbolo `metadata` sintético.
- **`unfoldSymbol` faz back-scan de comentários** (`parser.ts:1026-1037`): sobe a partir do símbolo incluindo JSDoc/decorators/`@`/`//` colados acima.

## Decisões abertas

1. **v1 regex vs v2 tree-sitter direto?** Recomendação: v1 primeiro pra medir ganho real, decidir v2 com dado.
2. **Heurística no prompt ou auto-degradação?** Claude-mem deixa o LLM decidir. Claudin pode auto-degradar `Read` para outline quando `lines > N` com flag `expand=true`. Trade-off: simplicidade pro modelo vs surpresa pro usuário.
3. **Que linguagens na v1?** TS/JS/Python/Go cobrem ~80% do trabalho típico nesta base.

## Medição esperada

Sem benchmark próprio ainda. Plano de validação: rodar 10 sessões reais sobre o próprio Claudin antes/depois, medir `prompt_tokens` agregado por chamadas de `FileReadTool`.

## Correções pós-verificação (2026-05-19)

| Claim original | Status | Correção |
|---|---|---|
| `smart_outline` :671, `smart_search` :708, `smart_unfold` :752 | ❌ | Ordem real: `smart_search` **:671**, `smart_unfold` **:708**, `smart_outline` **:752** |
| "25+ grammars", `LANG_MAP` em `parser.ts:34-76` | ❌ | **24 grammars**, em `GRAMMAR_PACKAGES` `parser.ts:183-209` |
| `.claude-mem.json` forma flat `{".sol": "pkg"}` | ❌ | Forma aninhada `{package, extensions[]}` chaveada por linguagem |
| (implícito) usa tree-sitter como lib | ❌ | Faz **shell-out para o CLI `tree-sitter`** — gotcha de portabilidade |
| parser.ts ~1042 LoC, `MAX_FILE_SIZE 512KB`, maxDepth 20, `SKILL.md:92` | ✓ | Confirmados |

## Arquivos de referência (claude-mem)

| Tema | Arquivo:linha |
|---|---|
| Parser engine + grammars | `src/services/smart-file-read/parser.ts:183-209` |
| Defensive limits | `src/services/smart-file-read/search.ts:33-40,61,97` |
| MCP tool defs | `src/servers/mcp-server.ts:671, 708, 752` |
| Skill instructions | `plugin/skills/smart-explore/SKILL.md:88, 92` |
