# Fit 03 — Prompts em `.md` (text-import)

> Análise de encaixe + ganho real. Não é plano de implementação.
> Inputs: `docs/discovery/ohmypi/03-prompts-as-md-textimport.md`, `docs/discovery/ohmypi/deep/03-prompts-as-md-textimport.md`.

## 1. Estado real do loader

`scripts/build.ts:397-431` já implementa um loader esbuild bidirecional para `.md` e `.txt`:

- `onResolve({ filter: /\.(md|txt)$/ })` resolve o path absoluto e marca namespace `text-stub`.
- `onLoad({ namespace: 'text-stub' })`:
  - Se o arquivo existe: `export default ${JSON.stringify(text)};` — inlina o conteúdo no bundle.
  - Se não existe: `export default '';` — stub silencioso (proposital para upstream files não-mirrorados).

Conclusão: **não é preciso adicionar nada ao loader.** A sintaxe omp `with { type: "text" }` é redundante aqui — `import x from './foo.md'` já funciona.

Uso atual confirmado (Grep `from .*\.md` em `src/**/*.ts`):

- `src/skills/bundled/claudeApiContent.ts:4-29` — 26 imports `.md` (skill Claude API completo).
- `src/skills/bundled/verifyContent.ts:4-6` — 3 imports `.md` (skill verify).

Total: **29 imports `.md` em produção, em 2 arquivos**, todos dentro de `src/skills/bundled/`. Zero fora de skills. O padrão existe, é restrito a payloads de skill.

## 2. Inventário concreto de prompts inline

Critério: arquivos `.ts` contendo prompt como template literal (`prompt.ts` de tools, coordinator, agentes built-in, extractMemories), `wc -c >500` no arquivo inteiro (proxy razoável, dado que >90% do conteúdo é o literal).

Total: **43 arquivos**, **~213.000 chars** em código TS dedicado a prompts (fora skills bundled).

Top 13 por tamanho (file:size:interp_count):

| File | chars | linhas | `${…}` |
|---|---:|---:|---:|
| `src/services/extractMemories/extractMemories.ts` | 21 501 | 609 | 21 |
| `src/coordinator/coordinatorMode.ts` | 19 038 | 369 | 34 |
| `src/tools/BashTool/prompt.ts` | 18 040 | 326 | 25 |
| `src/tools/AgentTool/prompt.ts` | 14 797 | 255 | 29 |
| `src/tools/PowerShellTool/prompt.ts` | 9 826 | 145 | 15 |
| `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts` | 8 938 | 205 | 28 |
| `src/services/extractMemories/prompts.ts` | 7 944 | 156 | 16 |
| `src/tools/TeamCreateTool/prompt.ts` | 6 895 | 113 | **0** |
| `src/tools/SkillTool/prompt.ts` | 6 885 | 205 | 10 |
| `src/tools/ScheduleCronTool/prompt.ts` | 6 145 | 117 | 8 |
| `src/tools/ToolSearchTool/prompt.ts` | 5 197 | — | **0** |
| `src/tools/EnterPlanModeTool/prompt.ts` | 4 683 | — | 3 |
| `src/tools/AgentTool/built-in/exploreAgent.ts` | 4 513 | 83 | 10 |
| `src/tools/AgentTool/built-in/planAgent.ts` | 4 337 | 93 | 8 |
| `src/tools/AgentTool/built-in/webResearcherAgent.ts` | 3 844 | 52 | 9 |
| `src/tools/TodoWriteTool/prompt.ts` | 3 368 | — | **0** |
| `src/tools/FileReadTool/prompt.ts` | 3 085 | — | 5 |

Distribuição de interpolação (43 arquivos com `prompt.ts` ou equivalente):

- ~3 arquivos com **0** `${}` (TeamCreate, ToolSearch, TodoWrite) — candidatos perfeitos.
- ~15 arquivos com **1–5** `${}` — candidatos viáveis com mini-renderer.
- ~12 arquivos com **8–15** `${}` — fronteira.
- ~6 arquivos com **>20** `${}` (Coordinator 34, AgentTool 29, claudeCodeGuide 28, BashTool 25, extractMemories 21) — onde o ganho começa a ser questionável.

## 3. Ganhos medidos

**LOC reduzida.** Trocar `\`...\`` em `.ts` por `.md`:
- Elimina escapes `` \` ``, `\${`, `\\n` e indentação artificial. Estimativa: **~10–15% redução em chars** no arquivo grande. Em `BashTool/prompt.ts` (18 KB), seriam ~2 KB menos. Em LOC, o `.md` típico tem ~mesma contagem de linhas, mas linhas legíveis.
- Em arquivos como `TeamCreateTool/prompt.ts` (113 linhas, 100% string) o ganho é total: vira `import md from './prompt.md'; export function getPrompt() { return md }` (3 LOC).

**Diff readability.** Simulação mental: mudar um parágrafo em `BashTool/prompt.ts:70-90` hoje produz um diff com guards de escape e linhas longas embrulhadas. Em `.md`, é diff de prosa — revisor lê em segundos, sem ruído sintático. **Ganho real e alto** em revisão.

**Hot-reload.** Loader inlina em build-time. Hoje uma mudança em `prompt.ts` exige `bun run build`. Com `.md`, **idem** — tem que rebuildar. **Zero ganho** aqui (omp também tem o mesmo).

**Bundle size.** O texto já vive no bundle final (string literal vira string literal). Diferença esperada: **0 bytes** (talvez ±0.1% pelo JSON.stringify vs. parser TS). **Zero ganho.**

**Tipo-check em strings interpoladas.** Hoje, `${TOOL_NAME}` é checado pelo TS — typo vira erro de compile. Em `.md` com Handlebars/`{{TOOL_NAME}}`, o nome é só uma string até runtime. **Perda real.**

## 4. Encaixe — template engine?

Não existe template engine no Claudin. Prompts hoje resolvem variáveis de quatro maneiras:

1. **Template literal puro** com `${expr}` (a maioria). Ex.: `BashTool/prompt.ts` interpola `AGENT_TOOL_NAME`, `getMaxBashTimeoutMs()`, condicionais via `${cond ? '...' : ''}`.
2. **Concatenação condicional** dentro da função. Ex.: `coordinatorMode.ts:104-106` (`content += ...`).
3. **Composição de fragmentos** importados — `src/constants/prompts.ts` exporta `prependBullets()`; `BashTool/prompt.ts:2` importa.
4. **Mini-funções** retornando trecho ou `null` para gating (`getBackgroundUsageNote()` em `BashTool/prompt.ts:31`).

Grep `prompt.*template|render.*prompt` em `src/`: **nenhum match relevante**. A migração exigiria introduzir um renderer (Handlebars como omp, ou um `{{var}}` minimalista). Adiciona **~1 dependência (ou ~30 LOC se feito à mão)** + um conceito novo para o time + um vetor extra de bug ("placeholder não substituído").

## 5. Onde ganha de verdade

Candidatos top-5 (alto valor, baixo custo):

| # | File | chars | %estático | Por quê |
|---|---|---:|---:|---|
| 1 | `src/tools/TeamCreateTool/prompt.ts` | 6 895 | **100%** | Zero `${}`. Conversão trivial. |
| 2 | `src/tools/ToolSearchTool/prompt.ts` | 5 197 | **100%** | Zero `${}`. |
| 3 | `src/tools/TodoWriteTool/prompt.ts` | 3 368 | **100%** | Zero `${}`. |
| 4 | `src/tools/AgentTool/built-in/exploreAgent.ts` | 4 513 | ~95% | 10 `${}` em nomes de tools — viraria `{{TOOL_LIST}}` injetado por uma camada acima. Prompt é puro guideline de pesquisa. |
| 5 | `src/tools/AgentTool/built-in/planAgent.ts` | 4 337 | ~95% | Mesma estrutura do explore. |

Ganhos extras nesses 5:
- Syntax highlight de markdown no editor (cabeçalhos, listas, code fences) — útil porque os prompts **já são markdown** dentro das strings.
- Snapshot tests de prompts ficam mais limpos (`expect(md).toMatchSnapshot()` direto).
- Diff de PR vira diff de prosa em todos.

## 6. Onde NÃO ganha (ou complica)

- **Coordinator** (`coordinatorMode.ts`, 34 `${}`): muitas interpolações vêm de _condicionais_ (`feature(...)`, `isEnvTruthy`, `isUsing3PServices`, `serverNames.join`). Em `.md` viraria `{{#if FOO}}...{{/if}}` Handlebars — adiciona o engine completo. Perde-se a checagem de tipo de cada flag. **Custo > benefício.**
- **BashTool/prompt.ts** (25 `${}`): igual. Tem `feature('OPENAI_BASH_HARDENING')` dentro do texto — build preprocessor (vide CLAUDE.md) precisaria continuar funcionando, e ele opera em `.ts`. Mover para `.md` quebra o feature-flag pipeline.
- **claudeCodeGuideAgent** (28 `${}`): apesar de o deep dive sugerir como "100% estático", os 28 interpolations vêm de tool-name constants e URLs. Migrável, mas exige mais placeholders do que markdown estático.
- **Prompts gated por feature flag dentro do texto**: o preprocessor de `feature('X')` em `scripts/build.ts` só opera em `.ts`. Migrar prompts com feature flags para `.md` exige duplicar o pipeline ou puxar a condicional para fora (assembly em TS, leitura de fragmentos `.md`).
- **Prompts compostos em runtime** (`BashTool/prompt.ts:35` `getBackgroundUsageNote()` retorna `string | null` para gating): hoje é elegante TS; em `.md` vira ginástica de partials ou volta a montagem para TS.

## 7. Riscos

- **Stub silencioso (`export default ''`).** Hoje protege upstream files; depois da migração vira **bug invisível**: typo no path do import = prompt vazio no bundle, agente fica mudo, nenhum erro em build. omp não tem isso (build falha em path errado). **Mitigação obrigatória**: build invariant test (`scripts/prompts-source-guard.test.ts`) que verifica todo import `.md` sob `src/prompts/` resolve para arquivo existente.
- **Perda de TS type-check** em variáveis substituídas (`${TOOL_NAME}` checa hoje; `{{TOOL_NAME}}` não checa). Mitigação: gerar `.d.ts` ou checar placeholders em test.
- **Refactor de tooling**: ESLint/Biome não lintam `.md`; reviewers precisam reconfigurar editor; pre-commit hooks que validam prompts (se houver) precisam de novo target.
- **Drift entre `.md` e código**: hoje refatorar `TOOL_NAME` constant atualiza prompt automaticamente. Após migração, requer atualizar placeholder e renderer — risco de prompt referenciar tool inexistente em runtime.
- **`feature()` preprocessing** documentado em CLAUDE.md mutaciona `.ts` files. Mover lógica para `.md` exige repensar esse mecanismo para esses prompts.

## 8. Veredito

Não vale **migração total**. O loader já está pronto, mas o ROI cai abruptamente conforme cresce a interpolação, e os 5–6 prompts mais críticos (Coordinator, BashTool, AgentTool, extractMemories) são justamente os mais interpolados. Migrar todos exige:
- Introduzir engine de template (custo: dep + conceito + perda de typecheck).
- Repensar feature-flag preprocessing para `.md`.
- Adicionar guard de path-resolve obrigatório.

Vale **migração cirúrgica dos top-5** acima:
1. `TeamCreateTool/prompt.ts` (100% estático)
2. `ToolSearchTool/prompt.ts` (100% estático)
3. `TodoWriteTool/prompt.ts` (100% estático)
4. `AgentTool/built-in/exploreAgent.ts` (~95% estático)
5. `AgentTool/built-in/planAgent.ts` (~95% estático)

Soma: **~24 KB de string-em-código → 5 `.md` files + 5 wrappers de 3 LOC**, sem precisar de template engine (basta um `replace` para os ~20 placeholders combinados). Estabelece convenção, valida o pipeline, dá highlight/diff/snapshot wins onde importa, sem pagar o custo da migração ampla.

Pré-requisito obrigatório antes da primeira migração: **trocar o stub silencioso (`export default ''`)** por erro fatal quando o path resolve para dentro de `src/prompts/` ou de um diretório explícito de migração — caso contrário um typo apaga o prompt sem deixar rastro.

Vale a pena: **CONDICIONAL** — porque o loader já existe e os 3–5 candidatos 100%-estáticos têm ganho real de revisão sem custo de engine, mas migrar os prompts grandes interpolados (Coordinator, BashTool, AgentTool, extractMemories — ~60% do volume) custa um template engine + redesenho do feature-flag preprocessing + perda de type-check, e nenhum desses arquivos sofre na prática com diff legibility o bastante para justificar.
