# Gap 03 — Prompt management / engine / composição

Padrões além de "prompt em `.md`" que não entraram em `03-*` insight/deep/fit.

## 1. Mecanismos do omp não cobertos

### 1.1 Engine Handlebars central (`packages/utils/src/prompt.ts`)
- `compile()` com cache LRU `Map<string,fn>` (`prompt.ts:454-465`).
- `render(tmpl, ctx)` com `noEscape: true, strict: false` (`:467-471`).
- `disambiguateClosingBraces()`: workaround do lexer para `}}}` em snippets JSON (`:450-452`).
- Instância isolada via `Handlebars.create()` (`:226`).

### 1.2 Helpers customizados registrados globalmente
- `{{arg N}}` — argumentos posicionais de slash-command (`prompt.ts:228-235`).
- `{{#list items prefix suffix join}}` (`:242-252`).
- `{{join}}`, `{{default}}`, `{{pluralize}}`, `{{len}}`, `{{add}}`, `{{sub}}` (`:258-386`).
- `{{#when a "==" b}}` — operadores `==/!=/>/</>=/<=` (`:283-300`).
- `{{#ifAny}}` / `{{#ifAll}}` (`:306-318`).
- `{{#table rows headers}}` (`:324-335`).
- `{{#codeblock lang}}` (`:341-345`).
- `{{#xml "tag"}}` — vazia se conteúdo vazio (`:351-355`). Evita tags-vazias-no-prompt.
- `{{escapeXml}}`, `{{#has}}`, `{{includes}}`, `{{not}}`, `{{jsonStringify}}` (`:361-428`).
- App-specific: `{{jtdToTypeScript}}` (`config/prompt-templates.ts:25-31`), hashline `{{hline}}`/`{{href}}` (`:67-155`).

### 1.3 `prompt.format()` — formatter normativo (~200 linhas)
- 2 fases: pre/post-render (`:6-12`).
- Remove blank line antes de `</xml>` e `{{/if}}` (`:197-208`).
- Compacta `| cell |` table rows.
- **`normalizeRfc2119`**: `**MUST NOT**` → `NEVER`, `**SHOULD NOT**` → `AVOID`, strip de bold em RFC2119 (`:29-46`). Convenção aplicada ao **conteúdo**, não só layout.
- `replaceAsciiSymbols`: `...` → `…`.
- `scripts/format-prompts.ts:43-56` — formatter como ferramenta com `--check` para CI.

### 1.4 Frontmatter de agents como partial reutilizável
`task/agents.ts:38-42`:
```ts
function buildAgentContent(def) {
  const body = prompt.render(def.template);
  return prompt.render(agentFrontmatterTemplate, { ...def.frontmatter, body });
}
```
`prompts/agents/frontmatter.md` é wrapper uniforme; corpo do agent vira `{{body}}`. Composição YAML+body sem `String.concat`.

### 1.5 Slash command templates user/project (overrides)
`config/prompt-templates.ts:180-`:
- Carregados de `~/.pi/prompts/` e `<project>/.pi/prompts/`.
- Source tag `"(user)" | "(project)"`.
- Subdirs viram namespaces.
- `expandSlashCommand` + `substituteArgs`: `$1 $2 $@ $ARGUMENTS` com slicing `$@[2:3]`.

### 1.6 Goals system com prompts dedicados
`prompts/goals/{goal-budget-limit,goal-continuation,goal-mode-active}.md` + `goals/runtime.ts:1-19`:
- 3 prompts disparados por estado de budget.
- `sendHiddenMessage({ customType, content, deliverAs })` — injeção controlada no transcript.

### 1.7 Memories como pipeline 2-stage com prompts
`memories/index.ts:11-14`: `consolidation.md`, `read-path.md`, `stage_one_input.md`, `stage_one_system.md` — sub-LLM por stage.

### 1.8 Plan-mode com 5+ fragments composíveis
`prompts/system/plan-mode-{active,approved,compact-instructions,reference,subagent,tool-decision-reminder}.md` — `agent-session.ts:158-164` carrega seletivamente.

### 1.9 TTSR (Tool-To-Steer-Reminder)
`prompts/system/ttsr-{interrupt,tool-reminder}.md` — interrupção injetada quando agente desvia.

### 1.10 Testes enforçando convenção
`test/prompt-format.test.ts` valida invariants. `test/system-prompt-templates.test.ts` cobre expansion.

## 2. Vale pra Claudin?

| Mecanismo | Vale? | Justificativa |
|---|---|---|
| Handlebars engine | Não na maioria | `fit/03:103-107` vetou — `${}` (34 em coordinator) tem typecheck que `{{}}` perde |
| Helpers `{{#xml}}` / `{{#codeblock}}` | Parcial | Útil se extractMemories migrar com fragments, mas custa engine |
| **`prompt.format` + `--check` CI** | **Sim, alto valor** | Aplicável **sem engine**. Normaliza `.md` existentes. ~150 LOC port |
| **`normalizeRfc2119`** | **Sim, baixo custo** | `.claudin/rules/*.md` cheios de `**MUST**`/`**NEVER**`. Sub-regra de format |
| **Frontmatter agent wrapper** | **Sim** | `src/tools/AgentTool/built-in/*.ts` (5 arquivos, 25KB) — todos inline. Pattern omp dá zero-code composição |
| Slash-command user/project overrides | Sim, fora deste gap | Útil mas escopo `/commands` |
| Goals system prompts | Não | Claudin não tem goals |
| **Memories 2-stage .md-driven** | **Sim, alto valor** | `src/services/extractMemories/prompts.ts` (7944 chars, 16 `${}`) — pipeline já existe. Top candidato |
| Plan-mode fragments | Sim | EnterPlanMode/ExitPlanMode/VerifyPlanExecution — fragmentação ajuda diff/test |
| TTSR-style reminders | N/A | Mecanismo de orquestração diferente |
| Hashline `{{hline}}`/`{{href}}` | N/A | omp-only mechanism |
| Format CI check | Sim, grátis após formatter | Plugar em `scripts/*.test.ts` invariants |
| Snapshot tests por prompt | Sim | Já citado em `deep/03:200-216`; gap adiciona validação **semântica** |
| I18n / pt-BR | omp não tem | Gap real mas não importado de omp |

## 3. Encaixe Claudin

### 3.1 Migrar memories prompts (highest ROI)
- `src/services/extractMemories/prompts.ts:1-156` (7944 chars, 16 interpolações) → `src/prompts/memories/{consolidation,extract,stage1-system,stage1-input}.md` espelhando omp.
- Mini-render `${X}` → `{{X}}` substituidor ~10 LOC, sem engine.

### 3.2 Adotar `prompt.format` parcial (sem engine)
- Novo `src/utils/promptFormat.ts` portando subset pre-render + `normalizeRfc2119` + `replaceAsciiSymbols` (~150 LOC, sem dep Handlebars).
- Novo `scripts/format-prompts.ts` análogo a omp `:31-60`. Modo `--check` para invariant test.
- Plugar em `scripts/feature-flags-source-guard.test.ts`-style guard: glob `src/prompts/**/*.md` + skill `.md`, falhar se `format(content)` !== `content`.

### 3.3 Helper de frontmatter para built-in agents
- `src/tools/AgentTool/built-in/{exploreAgent,planAgent,webResearcherAgent,claudeCodeGuideAgent,generalPurposeAgent}.ts` — todos fazem `frontmatter + body` inline.
- Extrair `buildAgentContent(frontmatter, bodyMd)` em `src/tools/AgentTool/built-in/buildAgent.ts` (análogo a omp `task/agents.ts:38-42`).

### 3.4 Plan-mode fragments
- `EnterPlanModeTool/prompt.ts` (4683 chars) + `ExitPlanModeTool` + `VerifyPlanExecutionTool` se sobrepõem.
- Dividir em `src/prompts/plan/{active,reference,tool-decision-reminder}.md`. Composição via constants TS.

### 3.5 Snapshot + validação semântica
- `src/prompts/__snapshots__/prompts.test.ts`:
  - `toMatchSnapshot()` por arquivo migrado.
  - `expect(rendered).toContain(...)` para placeholders obrigatórios.
  - `expect(rendered).not.toMatch(/\$\{/)` — captura interpolation leftover.
- Bonus: `scripts/prompts-source-guard.test.ts` — falha se template literal > 500 chars sob `src/tools/*/prompt.ts`.

### 3.6 Coordinator: **não migrar**
`src/coordinator/coordinatorMode.ts:1-369` (19038 chars, 34 `${}`, feature-flag interpolations) confirma veredito do fit.

## Referências
- omp engine: `/oh-my-pi/packages/utils/src/prompt.ts:226-471`
- omp helpers app: `/oh-my-pi/packages/coding-agent/src/config/prompt-templates.ts:25-156`
- omp formatter: `/oh-my-pi/packages/coding-agent/scripts/format-prompts.ts:19-60`
- omp frontmatter wrap: `/oh-my-pi/packages/coding-agent/src/task/agents.ts:38-42`
- omp memories: `/oh-my-pi/packages/coding-agent/src/memories/index.ts:11-14`
- Claudin: `src/services/extractMemories/prompts.ts`, `src/tools/AgentTool/built-in/*.ts`, `src/tools/{EnterPlanModeTool,ExitPlanModeTool,VerifyPlanExecutionTool}/prompt.ts`
