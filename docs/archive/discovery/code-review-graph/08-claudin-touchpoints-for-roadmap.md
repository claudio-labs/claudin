# 08 — Claudin touchpoints for the LSP-first roadmap

**Data:** 2026-05-27
**Repo:** `main @ c541013`
**Escopo:** mapeamento "onde pousa o código" para cada um dos 5 eixos do
roadmap. Os docs 04 e 05 já cobrem inventário LSP (13 ops em
`src/tools/LSPTool/schemas.ts:269-283`) e gaps de baseline; este doc não
repete, foca em `file:line` que serão tocados.

---

## Eixo 1 — Disciplina de uso (nudge LSP antes de Grep)

### 1. Files to touch

Built-in agent prompts ficam em `src/tools/AgentTool/built-in/`. Cada
arquivo define o `BuiltInAgentDefinition` exportado e o `systemPrompt`
inline:

- `src/tools/AgentTool/built-in/exploreAgent.ts:13-57` —
  `getExploreSystemPrompt()`; agente já lista `GREP_TOOL_NAME`/`GLOB_TOOL_NAME`
  como primeiras escolhas (linhas 44-45). LSP não é mencionado.
- `src/tools/AgentTool/built-in/planAgent.ts:14-71` —
  `getPlanV2SystemPrompt()`; export em `:73-93`. Reutiliza `EXPLORE_AGENT.tools`
  (`:85`).
- `src/tools/AgentTool/built-in/generalPurposeAgent.ts:3-23` —
  `SHARED_PREFIX` + `SHARED_GUIDELINES`. Export em `:25-34`.
- `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts` — agente de
  ajuda (não precisa de nudge LSP).
- `src/tools/AgentTool/built-in/webResearcherAgent.ts` — web-only,
  fora de escopo.

Tool descriptions (o que o modelo lê quando decide qual chamar):

- `src/tools/LSPTool/prompt.ts:1-14` — `LSP_TOOL_NAME = 'LSP'` e
  `DESCRIPTION = 'Code intelligence via LSP. ...'` (12 linhas).
- `src/tools/GrepTool/prompt.ts:4-18` — `GREP_TOOL_NAME = 'Grep'` +
  `getDescription()` function (não estática — permite condicional).

Builder central do system prompt do agente principal:

- `src/utils/systemPrompt.ts:41-119` — `buildEffectiveSystemPrompt(...)`.
- `src/constants/prompts.ts:384-501` — `getSystemPrompt()` (a fonte que
  o builder envolve). Seção `getUsingYourToolsSection(enabledTools)` em
  `:230-275` é onde uma "policy" tipo "para perguntas tipo X, prefira LSP
  antes de Grep" se encaixa.

### 2. APIs/types to extend

Nenhuma extensão de tipo necessária. O `BuiltInAgentDefinition.getSystemPrompt`
já é `() => string` (`exploreAgent.ts:82`). Tool description é string
estática em `prompt.ts`. O builder de prompt principal já aceita o set
de tools habilitadas (`getUsingYourToolsSection(enabledTools: Set<string>)`
em `constants/prompts.ts:230`), então um bloco condicional "se `LSP` está
no set" entra sem mudança de assinatura.

### 3. Existing helpers to reuse

- `hasEmbeddedSearchTools()` (chamado em `exploreAgent.ts:16`) — padrão
  de feature-detect que escolhe wording. Mesmo padrão serve para
  detectar LSP disponível.
- `featureFlags` em `scripts/build.ts:26-67` — flags como
  `BUILTIN_EXPLORE_PLAN_AGENTS` (true em `:46`) já controlam quais
  agentes carregam. Para A/B test de variantes de prompt o caminho
  natural é uma nova flag (ex: `LSP_FIRST_PROMPTS`) gated via
  `feature('LSP_FIRST_PROMPTS')`. Não há mecanismo de A/B test em
  runtime — só build-time.

### 4. Tests to copy patterns from

- `src/constants/promptIdentity.test.ts` — testa identity/wording dos
  prompts; padrão de regression test para alterações verbais.
- `src/tools/AgentTool/built-in/webResearcherAgent.test.ts` — único
  teste colocado ao lado de um built-in agent; usar como template para
  exploreAgent/planAgent.

### 5. Hidden coupling risks

- `EXPLORE_AGENT.tools` é reutilizado por `PLAN_AGENT` em
  `planAgent.ts:85`. Adicionar/remover `LSPTool` no tools set do Explore
  muda o Plan junto.
- `coordinator/workerAgent.ts:17` retorna
  `[WORKER_AGENT, GENERAL_PURPOSE_AGENT, EXPLORE_AGENT, PLAN_AGENT]`
  como agentes disponíveis no modo coordinator (flag `COORDINATOR_MODE`
  ligada em `scripts/build.ts:45`). Qualquer mudança nos prompts dos
  três últimos afeta também o coordinator worker.
- `DEFAULT_AGENT_PROMPT` em `src/constants/prompts.ts:658-659` é usado
  pelo loop principal quando nada mais especifica. Não confundir com os
  prompts de built-in agents.
- `getUsingYourToolsSection` (`constants/prompts.ts:230-275`) é
  compartilhado entre modos (simple/regular) — uma policy "prefira LSP"
  inserida ali aparece também em sessões headless.

---

## Eixo 2 — /review orquestrado com risk score

### 1. Files to touch

- `src/commands/review.ts:9-31` — `LOCAL_REVIEW_PROMPT(args)`; hoje só
  instrui o modelo a rodar `gh pr list/view/diff` e analisar
  livremente. Comando registrado em `:33-43`.
- `src/commands/security-review.ts:6-196` — `SECURITY_REVIEW_MARKDOWN`
  é um markdown com frontmatter `allowed-tools` + `!\`git diff ...\``
  inlines. Processado por `executeShellCommandsInPrompt` em `:215`.
  Padrão alternativo a copiar para o `/review` se quisermos `git diff`
  pré-executado.
- `src/services/git/gitDiff.ts:114-135` — `fetchGitDiffHunks()` já existe e
  retorna hunks parseados (!).
- `src/services/git/gitDiff.ts:200-298` — `parseGitDiff(...)`.
- `src/services/git/gitDiff.ts:148-189` — `parseGitNumstat(stdout)`.
- `src/services/git/gitDiff.ts:405-441` — `fetchSingleFileGitDiff(...)` retorna
  `ToolUseDiff` (definido `:386-395`).

### 2. APIs/types to extend

LSPTool retorna o suficiente: `formatResult` em
`src/tools/LSPTool/LSPTool.ts:886-1082` já calcula `resultCount` e
`fileCount` para `findReferences` (`:929-948`) e `incomingCalls`
(`:1054-1064`). O bloco formatado pode ser parseado, mas para evitar
re-parse o caminho limpo é expor uma versão estruturada:

- Adicionar `RiskScoreEntry` type novo (provavelmente
  `src/commands/review/riskScore.ts`):
  `{ symbol: string; file: string; refCount: number; incomingCalls: number; risk: 'low' | 'med' | 'high' }`.
- `LSPTool.execute` hoje retorna `{ formatted, resultCount, fileCount }`
  (via `formatResult`). Para uso programático interno (fora do tool
  registry) pode-se chamar diretamente `sendRequest<T>` do
  `LSPServerManager` (`src/services/lsp/LSPServerManager.ts:27` /
  `:265-274`) — bypassa permission gate e formato textual.
- `GitDiffResult` (`src/services/git/gitDiff.ts:29-33`) e
  `PerFileStats` (`:22-27`) já existem e devem ser mantidos; um wrapper
  que cruze isso com `findReferences` produzirá `RiskScoreEntry[]`.

### 3. Existing helpers to reuse

- `fetchGitDiffHunks()` — `src/services/git/gitDiff.ts:114-135` (NÃO é só
  numstat; retorna hunks).
- `parseGitDiff` — `:200-298`. Hunk parser pronto.
- `parseRawDiffToToolUseDiff` — `:448-481`.
- `executeShellCommandsInPrompt` — usado por
  `security-review.ts:215`; injeta saída de `!`cmd`` no template
  markdown. Reutilizar para colar a tabela de risco.
- `parseFrontmatter` (`security-review.ts:1`) +
  `parseSlashCommandToolsFromFrontmatter` (`:2`) — padrão de comando
  markdown com `allowed-tools`. `/review` hoje NÃO usa esse padrão (é
  prompt puro); para `--minimal` mode vale migrar.
- `LSPServerManager.sendRequest<T>` — `src/services/lsp/LSPServerManager.ts:27`,
  implementação `:265-274`.
- `scanSymbols(source, lang)` — `src/tools/shared/codeOutline/scanSymbols.ts:104`
  + `detectOutlineLang(ext)` em `:73`. Útil para resolver "qual símbolo
  cobre a linha X" sem chamar LSP. Cobre TS/JS/Python/Go.

### 4. Tests to copy patterns from

- `src/services/wiki/init.test.ts` — boa referência de teste de
  comando/serviço com fs.
- Não há teste para `/review` (`src/commands/review*.test.ts` não
  existe). Criar `src/commands/review.test.ts` do zero, mirroring
  `init.test.ts`.
- `src/services/git/gitDiff.ts` tem testes? `Grep` mostra suíte ausente para
  esse arquivo no momento desta pesquisa — pode ser oportunidade.
- `src/tools/LSPTool/LSPTool.readonly.regression.test.ts` — padrão de
  smoke test que sobe o LSP de verdade; pesado, evitar em tests do
  /review (mockar via `LSPServerManager` em vez de subir o real).

### 5. Hidden coupling risks

- `review.ts` exporta também `ultrareview` (`:48-54`) gated em
  `isUltrareviewEnabled()` (`:3`). Mudanças no `LOCAL_REVIEW_PROMPT` não
  devem atingir o `ultrareview` (é `local-jsx`).
- `security-review.ts:198-243` é um `createMovedToPluginCommand` — ele
  está sendo gradualmente movido para plugin externo. Replicar seu
  padrão no /review pode quebrar quando o plugin nascer.
- `MAX_FILES = 50` (`gitDiff.ts:36`) e `MAX_DIFF_SIZE_BYTES = 1_000_000`
  (`:37`) — PRs grandes serão truncados antes do risk score.
- `executeShellCommandsInPrompt` exige `allowed-tools` no frontmatter
  para permitir `!\`git diff\``; se /review virar markdown sem
  frontmatter correto, falha silenciosa em sessões com permissions
  restritivas.

---

## Eixo 3 — Wiki auto-gerada

### 1. Files to touch

- `src/services/wiki/init.ts:6-37` — `buildSchemaTemplate(projectName)`;
  template estático genérico.
- `src/services/wiki/init.ts:39-56` — `buildIndexTemplate(projectName)`;
  hoje cita só `Architecture` page.
- `src/services/wiki/init.ts:58-63` — `buildLogTemplate(timestamp)`.
- `src/services/wiki/init.ts:65-89` — `buildArchitectureTemplate(projectName)`;
  placeholder com "What are the most important runtime subsystems?"
  literal.
- `src/services/wiki/init.ts:112-140` — `initializeWiki(cwd)`; orquestra
  mkdir + ensureFile. É o entrypoint chamado pelo comando.
- `src/services/wiki/indexBuilder.ts:31-68` — `rebuildWikiIndex(cwd)`;
  hoje só listMarkdownFiles + getPageTitle, sem análise de código.
- `src/services/wiki/ingest.ts:49-93` — `ingestLocalWikiSource(...)`;
  base para o "summarizer per module".
- `src/commands/wiki/wiki.tsx:76-114` — `runWikiCommand(...)`; dispatcher
  do slash (`init`/`ingest`/`status`).
- `src/commands/wiki/wiki.tsx:12-26` — `renderHelp()`; texto que precisa
  mencionar `wiki generate` (ou similar) se virar comando novo.

### 2. APIs/types to extend

- `WikiInitResult` (importado em `init.ts:4`, definido em
  `src/services/wiki/types.ts`) — hoje carrega só
  `{ root, createdFiles, createdDirectories, alreadyExisted }`. Para
  geração automática adicionar campos: `modulesAnalyzed`, `summariesGenerated`.
- Novo type `ModuleSummary { dir: string; files: string[]; symbols: SymbolEntry[]; importsTo: string[]; }`
  ao lado de `src/services/wiki/types.ts`.

### 3. Existing helpers to reuse

- `scanSymbols` + `detectOutlineLang` —
  `src/tools/shared/codeOutline/scanSymbols.ts:104` / `:73`.
  Regex-only, cobre TS/JS/Python/Go (`OutlineLang` em `:41`).
- `renderOutline` — `src/tools/shared/codeOutline/renderOutline.ts`
  (mesma pasta). Já formata symbols para markdown-ish.
- `FileReadTool.ts:1027` define `view: 'outline' | undefined`; em
  `:1263` faz `if (outlineLang && view === 'outline')`. Pode ser
  chamado programaticamente — ou ir direto ao `scanSymbols`, evita
  passar pelo tool-permission gate.
- Não há utilitário de import-graph (`Grep` por `importGraph`/
  `moduleGraph` em `src/` deu zero hits úteis). É construção nova —
  regex sobre `^import .* from ['"](.+)['"]` aplicado por arquivo,
  resolvendo via `tsconfig.json` paths (alias `src/*` documentado em
  `CLAUDE.md`).
- `paths.ts` (em `src/services/wiki/paths.ts`) já centraliza
  `.claudin/wiki/` paths; cache de output cabe lá.

### 4. Tests to copy patterns from

- `src/services/wiki/init.test.ts` — happy path + idempotência (EEXIST
  handling em `init.ts:99-107`).
- `src/services/wiki/ingest.test.ts` — fs interaction.
- `src/services/wiki/status.test.ts` — leitura/parsing.

### 5. Hidden coupling risks

- `paths.ts` resolve `.claudin/wiki/` relativo a `cwd` — em PRs
  rodados de subdir o destino muda. `cwd` é passado pelo
  `runWikiCommand` em `wiki.tsx:76-114` a partir do context do REPL.
- `.gitignore` (raiz, linha `/.claudin`) ignora wiki gerada por padrão
  — geração auto deve avisar usuário que vai ficar fora do commit. OK
  pro princípio mas confunde quem espera ver `pages/*.md` no `git add`.
- `ensureFile` em `init.ts:91-110` usa `flag: 'wx'` (não sobrescreve).
  Regeneração precisa ou deletar primeiro ou usar flag diferente — bug
  potencial se "wiki regenerate" reaproveitar `ensureFile`.
- `rebuildWikiIndex` (`indexBuilder.ts:31`) reescreve `index.md` por
  cima a cada chamada (não usa `wx`). Inconsistência interna ao
  módulo.

---

## Eixo 4 — Cache LSP in-memory por sessão

### 1. Files to touch

- `src/services/lsp/LSPServerManager.ts:265-274` — `sendRequest<T>`,
  ponto único de dispatch onde a memoização envolve.
- `src/tools/LSPTool/LSPTool.ts:671-763` — `getMethodAndParams(input, absolutePath)`;
  gera a tupla `(method, params)` que vira chave de cache junto com
  content-hash de `absolutePath`.
- `src/tools/LSPTool/codeActionCache.ts:30-74` — cache existente
  (TTL 5min, max 200, in-memory `Map<string, CachedCodeAction>`). Padrão
  já estabelecido; expandir com novo módulo irmão
  `src/tools/LSPTool/symbolCache.ts` ou refatorar para genérico.
- `src/services/tools/toolExecution.ts:1762-1779` —
  `invalidateCacheForWrite(toolName, input)`; já invalida path-by-path
  para `FileEditTool`/`FileWriteTool`/`NotebookEditTool` e `invalidateAll()`
  para Bash/PowerShell. **Esse é o hook de invalidação que precisamos
  expandir** — adicionar `invalidateLSPSymbolCache(path)` ao branch
  Edit/Write/Notebook, e drenar tudo no branch Bash.
- `src/tools/shared/twoTierCache.ts:102-313` —
  `createTwoTierCache<K,V>(...)`. Stats + memory/disk tiers + decisão
  fresh/stale/miss em `:23-24`. Reutilizável como base.

### 2. APIs/types to extend

- `LSPServerManager.sendRequest<T>` (`src/services/lsp/LSPServerManager.ts:27`)
  não muda assinatura. Wrap pode ser feito do lado de fora (no LSPTool)
  ou interno opcionalmente.
- Novo type `LSPCacheKey = \`${operation}:${absolutePath}:${line}:${character}:${contentHash}\``
  e `LSPCacheEntry<T> = { result: T; cachedAt: number; size: number }`.
- `invalidateCacheForWrite` em `toolExecution.ts:1762` deve passar a
  receber também opção para LSP cache (ou importar a função de
  invalidação).

### 3. Existing helpers to reuse

- `createTwoTierCache` — `src/tools/shared/twoTierCache.ts:102`.
  `TwoTierCacheOptions<V>` em `:45-73`. Padrão Claudin-nativo.
- `decideCacheAction` — `:23`.
- `invalidateForPath` / `invalidateAll` — funções importadas no
  branch `invalidateCacheForWrite` (`toolExecution.ts:1768/1777`); são
  do `twoTierCache` ou do file-history. Reusar mesmo padrão.
- Content hash: NÃO existe helper centralizado em `src/utils/` para
  hash de arquivo. Há `sha256` espalhado (`src/services/session/`,
  vários sites). Para LSP cache vale `Bun.hash` (instantâneo) ou
  `crypto.createHash('sha1')` em conteúdo já-em-memória — content é
  lido no `LSPServerManager` quando notifica `textDocument/didChange`
  (linha 348 do mesmo arquivo). Reusar o `Buffer` daí.
- `codeActionCache.ts:18-43` padrão de TTL + eviction simples — copiar.

### 4. Tests to copy patterns from

- `src/tools/LSPTool/codeActionCache.test.ts` — testa exatamente esse
  padrão (TTL, eviction, retrieval).
- `src/tools/shared/twoTierCache.test.ts` — para o caso de usar o
  helper compartilhado.

### 5. Hidden coupling risks

- `LSPServerManager.sendRequest` é chamado também por código fora do
  `LSPTool` (ex: `services/lsp/LSPDiagnosticRegistry.ts` per doc 05).
  Memoização no nível do manager afeta consumidores não-tool.
  Recomendado wrap externo, no LSPTool.
- `Bash` ainda invalida tudo (`toolExecution.ts:1777`) — manter para
  LSP cache também (qualquer `bun run X` pode escrever arquivos).
- LSP server tem seu próprio cache interno (e ele já recebe
  `textDocument/didChange` em `LSPServerManager.ts:348`). Memoizar do
  lado do client é OK só se invalidação for confiável; um falso-hit em
  `findReferences` enviesa o risk score do /review.
- `codeActionCache` é específico — não dá pra reusar Map direto, mas o
  shape de `evictExpired`/`evictOldestIfFull` é copiável.

---

## Eixo 5 — Índice persistente cross-sessão (DEFER, sanity check)

### 1. `.claudin/` runtime writes?

Sim, intensivamente. `~/.claudin/` listado contém:

```
backups, cache, config.json, file-history, history.jsonl,
last-update-check, latest-version.json, model-cache, paste-cache,
plans, plugins, projects, session-env, sessions, settings.json,
shell-snapshots, tasks, v8cache
```

Também há `.claudin/` no repo (gitignored em `/.claudin` na raiz do
`.gitignore`) com `rules/`, `settings.local.json`, `worktrees/`.

Confirmação da preocupação `verify-privacy-bundle-only` (memória):
`bun run verify:privacy` só grepa `dist/cli.mjs`. Tudo que é escrito em
runtime em `~/.claudin/` está fora do gate. Persistir índice cross-sessão
adiciona mais um diretório com conteúdo derivado de código do usuário
(potencialmente sensível).

### 2. SQLite no bundle?

`Grep` por `sqlite|better-sqlite` no repo retornou só docs (CRG, ohmypi
discovery) e o ROADMAP — nenhum import real em `src/` ou
`package.json`. Adicionar SQLite seria:

- `package.json` ganha dep nativa (`better-sqlite3` ou similar).
- `scripts/build.ts:113-117` faria pre-scan e provavelmente stubaria
  como módulo missing — exigiria gate `feature('PERSISTENT_INDEX')` +
  ajuste do bundle plugin.
- Bundle hoje é puramente JS/TS — adicionar native addon quebra o modelo
  "single-file `dist/cli.mjs`" descrito em `CLAUDE.md`.

Alternativa sem dep nativa: serializar `Map<symbol, file:line[]>` para
JSON gz em `~/.claudin/cache/<project-hash>/lsp-index.json.gz`. Caminho
mais barato, mas escala pior em monorepos.

Confirmando defer: ROADMAP já anota T5.10 descartado e CRG discovery
04/05 conclui que cross-session só vale em monorepos grandes.

---

## Estimated touch surface

- **Eixo 1:** 5 arquivos (3 prompts de built-in agent + 2 tool
  descriptions + 1 builder central), 0 novos types, 2 test files novos.
- **Eixo 2:** 3-4 arquivos (review.ts + novo `review/riskScore.ts` +
  reuso de gitDiff.ts + opcional migration para markdown frontmatter),
  2 novos types (`RiskScoreEntry`, `RiskTable`), 1-2 test files novos
  (`review.test.ts`, `riskScore.test.ts`).
- **Eixo 3:** 4-5 arquivos (init.ts reescrito + indexBuilder.ts
  expandido + novo `wiki/moduleAnalyzer.ts` + types.ts + wiki.tsx help
  text), 2 novos types (`ModuleSummary`, ampliação de `WikiInitResult`),
  2-3 test files novos.
- **Eixo 4:** 2-3 arquivos (novo `LSPTool/symbolCache.ts` + edição em
  `LSPTool.ts` para wrap + edição em `services/tools/toolExecution.ts:1762`
  para invalidate hook), 2 novos types (`LSPCacheKey`, `LSPCacheEntry`),
  1 test file novo (`symbolCache.test.ts`).
- **Eixo 5:** DEFER — 0 arquivos.

**Total:** 14-17 arquivos tocados, 6-8 novos types, 6-8 test files novos.
