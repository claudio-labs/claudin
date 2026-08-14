# Deep dive 03 — Prompts em `.md` via text-import

> Continuação de `docs/archive/discovery/ohmypi/03-prompts-as-md-textimport.md`. Foco: como migrar prompts inline do Claudin para arquivos `.md` reaproveitando o padrão omp.

## Resumo executivo

- omp tem regra dura em `AGENTS.md:31`: prompts **nunca** vivem em código. Todos viajam como `.md` importados via `with { type: "text" }` e renderizados com Handlebars (`prompt.render`).
- A regra é seguida com disciplina: ~70+ imports de `.md` rastreados em `packages/coding-agent` e `packages/agent`, organizados em `prompts/{agents,tools,system,commands,memories,goals}/`.
- Claudin já tem **toda a infraestrutura** para fazer o mesmo: `scripts/build.ts:397-431` inlina `.md`/`.txt` no bundle quando o arquivo existe (`export default <JSON string>`), e o padrão já é usado em `src/skills/bundled/*Content.ts` (40+ arquivos sob `src/skills/bundled/claude-api/`).
- O que falta é convenção e migração: ~7 prompts grandes ainda vivem como template literals dentro de `.ts`, somando >3.000 LOC de string-em-código nos arquivos críticos do agent loop.
- Não é preciso adicionar `loader: { '.md': 'text' }` nem a sintaxe `with { type: "text" }`: o `onResolve/onLoad` em `scripts/build.ts:403-431` já cobre o caso. Os imports omp-style funcionariam mas a anotação `with` é redundante.

## Padrão omp (refs file:line)

Manifesto:
- `/home/dev/projects/oh-my-pi/AGENTS.md:31` — "never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`."
- `/home/dev/projects/oh-my-pi/docs/porting-from-pi-mono.md:103` — mesma regra documentada como invariante de port.
- `/home/dev/projects/oh-my-pi/packages/coding-agent/DEVELOPMENT.md:886` — "Built-ins are embedded with `import ... with { type: \"text\" }` and parsed by `parseAgent(...)`."

Convenção de diretórios em `packages/coding-agent/src/prompts/`:

```
prompts/
├── agents/        designer.md, explore.md, librarian.md, oracle.md,
│                  plan.md, reviewer.md, task.md, init.md, frontmatter.md
├── commands/      orchestrate.md
├── system/        system-prompt.md, custom-system-prompt.md,
│                  project-prompt.md, plan-mode-*.md, subagent-*.md,
│                  ttsr-*.md, auto-continue.md, eager-todo.md, ...
├── tools/         um .md por tool (bash.md, read.md, write.md,
│                  search.md, todo-write.md, task.md, lsp.md, ...)
├── memories/      consolidation.md, read-path.md, stage_one_*.md
└── goals/         goal-budget-limit.md, goal-continuation.md, ...
```

Pontos de entrada bem visíveis:
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/task/agents.ts:9-18` — agents builtin (8 imports `.md`).
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/task/commands.ts:11-12` — slash-command bodies.
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/agent-session.ts:155-164` — system prompts dinâmicos da sessão.
- `/home/dev/projects/oh-my-pi/packages/agent/src/compaction/compaction.ts:30-35` — compactação (6 templates `.md`).

Dynamic content é injetado via `prompt.render(template, vars)` (Handlebars) — ver `task/agents.ts:38-42`.

## Estado atual no Claudin

### O que já existe

`scripts/build.ts:397-431` (loader bidirecional):

```ts
build.onResolve({ filter: /\.(md|txt)$/ }, (args) => {
  const fs2 = require('fs')
  const pathMod2 = require('path')
  const resolved = pathMod2.isAbsolute(args.path)
    ? args.path
    : pathMod2.resolve(args.resolveDir, args.path)
  return {
    path: fs2.existsSync(resolved) ? resolved : args.path,
    namespace: 'text-stub',
  }
})
build.onLoad({ filter: /.*/, namespace: 'text-stub' }, (args) => {
  const fs2 = require('fs')
  if (fs2.existsSync(args.path)) {
    const text = fs2.readFileSync(args.path, 'utf-8')
    return {
      contents: 'export default ' + JSON.stringify(text) + ';',
      loader: 'js',
    }
  }
  return { contents: `export default '';`, loader: 'js' }
})
```

Já em uso por:
- `src/skills/bundled/verifyContent.ts` (3 imports `.md` — incluindo `SKILL.md` + exemplos).
- `src/skills/bundled/claudeApiContent.ts` (~25 imports `.md` da árvore `claude-api/`).
- Runtime txt: `src/services/permissions/yolo-classifier-prompts/{auto_mode_system_prompt,permissions_external}.txt` é lido com `readFileSync` no test mas inlinado no bundle.

Conclusão: o caminho omp-style **já funciona hoje** no Claudin. Não precisa mudar o build.

### Mudança em `build.ts` (snippet conceitual)

Nenhuma mudança de loader é necessária. As únicas evoluções opcionais seriam:

```diff
# scripts/build.ts (~linha 403) — apenas se quisermos:
# 1) suportar a anotação `with { type: "text" }` explicitamente para evitar
#    futuras dúvidas de quem migrou do omp; e
# 2) falhar o build se um .md sob src/prompts/ não existir (em vez de stub '')

   build.onResolve({ filter: /\.(md|txt)$/ }, (args) => {
     const resolved = pathMod2.isAbsolute(args.path)
       ? args.path
       : pathMod2.resolve(args.resolveDir, args.path)
+    // Strict mode: prompts canônicos não podem virar stub silencioso.
+    if (!fs2.existsSync(resolved) && /\/src\/prompts\//.test(resolved)) {
+      throw new Error(`[build] required prompt not found: ${resolved}`)
+    }
     return {
       path: fs2.existsSync(resolved) ? resolved : args.path,
       namespace: 'text-stub',
     }
   })
```

A sintaxe `import x from "./foo.md" with { type: "text" }` é aceita por Bun nativamente (import attributes); a anotação é ignorada na resolução plugin-side e o resultado é idêntico ao import sem `with`. Pode-se padronizar **sem** mudar o plugin.

## 5 candidatos iniciais para migração

Ordenados por relação valor/risco (impacto na legibilidade × estabilidade do conteúdo). LOC = arquivo inteiro; o template literal interno é a maior parte.

| # | Arquivo (.ts) | LOC | Maior literal | Risco | Notas |
|---|---|---:|---:|---|---|
| 1 | `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts` | 205 | ~3.000 chars | Baixo | Prompt de agente built-in, **estático**, ideal como `src/prompts/agents/claude-code-guide.md`. |
| 2 | `src/tools/BashTool/prompt.ts` | 326 | 2.831 chars | Baixo | Tool description longa. 21 ocorrências de `${...}` — interpolação de plataforma/flags. Migrável com Handlebars-lite. |
| 3 | `src/tools/SkillTool/prompt.ts` | 205 | 1.287 chars | Baixo | Igual ao acima, menos vars. |
| 4 | `src/tools/AgentTool/prompt.ts` | 255 | 2.349 chars | Médio | 26 `${...}` incluindo branches por `forkEnabled` (feature flag). Precisa de templating com condicional. |
| 5 | `src/coordinator/coordinatorMode.ts` | 369 | 14.225 chars | Médio | Maior prompt do projeto, gated em `feature('COORDINATOR_MODE')`. 32 `${...}`. Migração rende a maior diff-reduction, mas precisa de condicionais. |

Candidatos secundários (não recomendados na 1ª onda — são mais "código gerador de texto" do que prompt):
- `src/commands/init.ts` (18k chars) — gera CLAUDE.md interativo, lógica forte.
- `src/commands/security-review.ts` (10k) — checklist gerado.
- `src/commands/insights.ts` (10k) — relatório, não prompt-to-LLM.
- `src/commands/init-verifiers.ts` (9.8k) — verificações encadeadas.

## Convenção sugerida

Espelhar omp no Claudin, ajustando ao layout `src/tools/<Name>/`:

```
src/prompts/                  # nova raiz canônica para prompts cross-cutting
├── agents/                   # built-in subagents (Agente, Explore, Plan, …)
├── system/                   # system prompts, modes (plan-mode-*, …)
├── coordinator/              # coordinatorMode.ts → split por seção
└── commands/                 # /init, /security-review se migrados
```

Para prompts **acoplados a uma tool**, manter no diretório da própria tool — match exato do padrão omp `tools/<name>.md`:

```
src/tools/BashTool/
├── BashTool.tsx
├── prompt.ts                 # vira loader fino que importa o .md
└── prompt.md                 # ← novo
```

Naming:
- Filename = `kebab-case.md`.
- Variável importada = `camelCase` + sufixo `Md` ou `Prompt` (consistente com omp: `exploreMd`, `summarizationSystemPrompt`).
- Um `.md` por prompt lógico; **não** concatenar prompts no mesmo arquivo.
- Frontmatter opcional (omp usa `frontmatter.md` template) — útil se precisarmos parsear metadados (nome, tools permitidos) como omp faz em `parseAgentFields`.

## Riscos

### 1. Templating com variáveis (`${...}` em template literals)

Hoje os prompts grandes interpolam coisas como `${AGENT_TOOL_NAME}`, `${forkEnabled ? '...' : ''}`, plataforma, contagem de tools, etc. Mover para `.md` exige um engine.

Opções:
- **Adotar Handlebars** (mesmo do omp). Adiciona dep (`handlebars` ~120kB) — pode ser pesado vs. o resto do bundle. omp usa `prompt.render` do pacote interno `@oh-my-pi/pi-utils`.
- **Placeholder substitution simples** (`{{var}}` → `replaceAll`). Suficiente para 90% dos casos atuais. Zero deps. Pode-se escrever em ~30 LOC em `src/utils/promptTemplate.ts`.
- **Concatenação no caller** (mantém `.md` 100% estático e monta as partes em código). Só funciona quando a estrutura condicional é simples ("inclui ou não inclui esse parágrafo").

Recomendação: começar com placeholder simples + fragmentos `.md` separados por condicional (ver omp `prompts/system/plan-mode-active.md` × `plan-mode-approved.md`). Só introduzir Handlebars se a complexidade pedir.

### 2. Feature flags dentro de prompt

`src/coordinator/coordinatorMode.ts` e `src/tools/AgentTool/prompt.ts` usam `feature('FLAG') ? 'A' : 'B'` para gatear seções do prompt. O preprocessor de `scripts/build.ts:93-129` substitui `feature(...)` por boolean literal **antes** do bundle, então o template literal final é fixo no build.

Se migrarmos para `.md`, a condicional sai do .md e vira composição no caller:

```ts
// prompt.ts (novo)
import basePrompt from './prompt.md'
import forkExtraPrompt from './prompt-fork.md'

export function getAgentPrompt() {
  const forkEnabled = feature('FORK_SUBAGENT')
  return forkEnabled ? `${basePrompt}\n\n${forkExtraPrompt}` : basePrompt
}
```

Isso preserva o gating sem precisar de Handlebars no .md.

### 3. Hot-reload em dev

Imports `.md` são resolvidos uma única vez na build. Não há hot-reload — toda mudança requer `bun run build`. Mesma DX que omp; o ganho de "editor render markdown" compensa.

### 4. Stub silencioso

O onResolve atual devolve `export default ''` quando o arquivo não existe (`scripts/build.ts:399-413`). Se renomearmos um prompt e esquecermos de atualizar o import, o agente recebe **string vazia** em produção, sem erro de build. Mitigação: o snippet `diff` acima — failar o build para paths sob `src/prompts/`.

### 5. Tamanho do bundle / cache de prompt

Cada `.md` vira string literal embedded. Bun já minifica, mas markdown puro não comprime tão bem quanto JS. Estimativa: ~20-30kB adicionais no `dist/cli.mjs` para os 5 candidatos, dominado por `coordinatorMode.ts`. Hoje esse texto já está no bundle (template literal), então o delta real é ~0.

## Como testar

Snapshot por prompt:

```ts
// src/prompts/__snapshots__/agents.test.ts
import { describe, expect, test } from 'bun:test'
import exploreMd from 'src/prompts/agents/explore.md'
import claudeCodeGuideMd from 'src/prompts/agents/claude-code-guide.md'

describe('agent prompts', () => {
  test('explore', () => {
    expect(exploreMd).toMatchSnapshot()
  })
  test('claude-code-guide', () => {
    expect(claudeCodeGuideMd).toMatchSnapshot()
  })
})
```

Contrato adicional (alinhado a `.claudin/rules/testing.md`):
- Asserts **semânticos** sobre cabeçalhos/placeholders, não bytes:

```ts
test('coordinator prompt contains all required placeholders', () => {
  for (const ph of ['{{TOOL_LIST}}', '{{PROVIDER_NAME}}']) {
    expect(coordinatorMd).toContain(ph)
  }
})
test('coordinator prompt has no leftover ${ interpolation', () => {
  // catch migration leftovers
  expect(coordinatorMd).not.toMatch(/\$\{/)
})
```

Bonus: guard de build invariant análogo a `scripts/feature-flags-source-guard.test.ts` — varrer `src/**/*.ts` por template literals com `>500` chars sob `src/tools/` ou `src/coordinator/` e falhar o test, pressionando a migração progressiva.

## Próximos passos sugeridos (fora deste documento)

1. Criar `src/prompts/agents/claude-code-guide.md` a partir do literal de `claudeCodeGuideAgent.ts` — migração com **zero** lógica condicional. Confirma o caminho end-to-end e estabelece a convenção.
2. Adicionar `src/utils/promptTemplate.ts` com `render(template, vars)` minimalista (`{{name}}` → `vars.name`).
3. Migrar `src/tools/BashTool/prompt.ts` (próximo em risco baixo, mais variáveis).
4. Apertar o build: tornar imports sob `src/prompts/` strict (erro se faltando).
5. Documentar convenção em `.claudin/rules/typescript-patterns.md`: "prompts > 500 chars vivem em `.md`".

## Referências

- omp: `packages/coding-agent/src/task/agents.ts:9-18`, `AGENTS.md:31`, `packages/coding-agent/DEVELOPMENT.md:886`, `packages/coding-agent/src/prompts/{agents,system,tools,commands,memories,goals}/`
- Claudin: `scripts/build.ts:397-431` (loader), `src/skills/bundled/verifyContent.ts:1-13` (uso atual), `src/skills/bundled/claudeApiContent.ts:1-29` (uso em escala)
- Inline-prompt candidatos: `src/coordinator/coordinatorMode.ts:116`, `src/tools/AgentTool/prompt.ts:108`, `src/tools/BashTool/prompt.ts:70`, `src/tools/SkillTool/prompt.ts:138`, `src/tools/AgentTool/built-in/claudeCodeGuideAgent.ts:30`
