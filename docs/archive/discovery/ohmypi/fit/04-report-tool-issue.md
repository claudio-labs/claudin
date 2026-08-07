# Fit analysis — `report_tool_issue`

Análise concreta de encaixe e ganhos reais de portar a meta-tool
`report_tool_issue` do oh-my-pi (omp) para Claudin. **Sem plano de
implementação, sem modificar código.**

## 1. Encaixe arquitetural

### Onde a tool moraria

`src/tools/ReportToolIssueTool/ReportToolIssueTool.ts` (mesma convenção
que `BashTool`, `GrepTool`, etc.: um diretório por tool, factory que
usa `buildTool(def)` de `src/Tool.ts:810`).

Tipo do retorno é `BuiltTool<D>` (`Tool.ts:762-768`). O contrato exige
`name`, `inputSchema`, `prompt`, `execute(input, ctx)` retornando
`ToolResult<T>` (`Tool.ts:348-363`). Cabe sem qualquer adaptação — omp
já é AsyncIterable-style também.

### Ponto de injeção: `src/tools.ts`

`getAllBaseTools()` (não mostrado nas linhas lidas, mas o assembly
canônico) é a lista de built-ins. O patch seria importar
`ReportToolIssueTool` e adicioná-lo ao array. A tool deve ser:

- **incondicional** no array base (igual omp: sempre injetada em
  agente principal E sub-agentes), MAS
- **gated por feature flag** `REPORT_TOOL_ISSUE` em
  `scripts/build.ts:26-66` (default `false` em primeiro release; depois
  promover para `true`).

A injeção no sub-agente acontece sozinha via `assembleToolPool()`
(`src/tools.ts:365-387`) — Explore/Plan workers chamam
`AgentTool.tsx:527` que reusa `assembleToolPool`. Não precisa ponto de
injeção extra: built-in significa "todos os agentes herdam".

O ponto delicado é o **enum dinâmico**: omp gera
`z.enum([...activeBuiltinNames])` por turno
(`report-tool-issue.ts:30-41`). Para Claudin, o schema teria que ser
construído com base no `ToolUseContext` no `execute` ou via construtor
factory recebendo a lista — a infra atual usa schemas estáticos
(`buildTool` espera `inputSchema` fixo). Solução prática: usar
`z.string()` simples (omp também faz fallback para isso em
`:34`) e validar no execute path contra a lista canônica de built-ins.
Trade-off aceitável: schema menos informativo p/ o modelo, mas evita
mexer no contrato de `Tool.ts`.

### Prompt do agente

Ponto de injeção: `src/services/extractMemories/prompts.ts` é prompt
de subagente extractor, não serve. O system prompt do agente principal
está montado em outro lugar (não tocou nesta análise, mas é onde uma
seção `<reporting-tool-issues>` ~3 linhas deveria entrar — análoga ao
`<critical>` block em omp `system-prompt.md:194-198`).

### Por que JSONL, não memory

`src/memdir/memoryTypes.ts:14-19` define **4 tipos** de memory:
`user | feedback | project | reference`. Relatos de tool issue
**não se encaixam** em nenhum:

- `feedback` é human→agent (preferências, restrições) — direção
  oposta.
- `project` exige conteúdo "não derivável do estado atual" — relatos
  de tool são derivativos (a tool existe, sua descrição existe).
- `reference` é factual sobre o projeto.

Memórias são `.md` indexadas em `MEMORY.md` e lidas TODA conversa
(custo de contexto). Empilhar 50+ reports lá poluiria o prompt sem
ajudar o modelo da próxima sessão.

Destino correto: arquivo JSONL append-only fora do scan de memória.
`getAutoMemPath()` (`memdir/paths.ts:223-235`) retorna
`~/.claudin/projects/<sanitized>/memory/`. Um subdir irmão
`~/.claudin/projects/<sanitized>/tool-issues/YYYY-MM.jsonl`
(uma linha por relato) fica naturalmente fora porque o memoryScan só
ingere `.md` no dir `memory/`. Confere com a recomendação do deep dive
(linhas 21-24).

## 2. Privacidade — análise rigorosa

### O que `verify:privacy` proíbe hoje

`scripts/verify-no-phone-home.ts:6-18` — banlist de **strings literais
no bundle**:

```
datadoghq.com, api/event_logging/batch, api/claude_code/metrics,
getKubernetesNamespace, /var/run/secrets/kubernetes,
/proc/self/mountinfo, tengu_internal_record_permission_context,
anthropic-serve, infra.ant.dev, claude-code-feedback, C07VBSHV7EV
```

É grep de **bundle final** (`dist/cli.mjs`). Não escaneia comportamento
runtime — só presença de endpoints/identifiers conhecidos. JSONL
local-only **passa trivialmente**: não há string nova a adicionar à
banlist enquanto não houver push remoto.

### Sanitização realmente necessária

`verify:privacy` não cobre o conteúdo do que o modelo escreve. O risco
real é o campo `report` (free-text 500ch) vazar:

1. **Paths absolutos** do user — modelo facilmente cita
   `/home/dev/...` ao descrever "tool X retornou erro lendo arquivo".
   Sanitização: regex que substitui paths absolutos por placeholders
   antes do write. Já existe utilitário relacionado em
   `src/utils/path.ts` (`sanitizePath`) mas é para sanitizar nome de
   diretório no projects-dir, não conteúdo livre.
2. **Conteúdo de arquivos lidos** — se modelo cola um snippet "para
   contexto". Mitigação: hard cap de 500 chars no schema (omp já faz)
   + prompt explícito proíbe.
3. **Identifiers de usuário** — nomes em paths, var de ambiente
   ecoada. Cobertura via path sanitization acima resolve a maioria.

Como Claudin é local-only por design, o JSONL nunca sai do disco do
user. Privacidade aqui é mais **higiene** (não poluir os próprios
logs do user com PII) do que ameaça externa.

## 3. Ganhos medidos / esperados

### Frequência real de tool failures hoje

`Grep "isError.*true"` em `src/`: **15 arquivos** tocam o conceito,
todos no caminho de propagação (compact stub, message normalize,
openaiShim, BashToolResultMessage). Não há **dataset** de quantas vezes
tools falham por sessão — não existe coleta. Logs estruturados são
chamadas de `logForDebugging` esparsas (vide
`extractMemories.ts:455-497`), úteis para debug de **um** componente,
não como agregado.

Inverso disso: **`MEMORY.md` do projeto não tem uma única entrada de
tool-issue** (lido em `/home/dev/.claudin/projects/-home-dev-projects-claudin/memory/MEMORY.md`).
Categorias atuais: indentação, review-agent, git identity, idioma,
versionamento, "plan elegance". Tudo direção human→agent. Confirma o
gap descrito em `04-report-tool-issue.md:12`.

### Quem consumiria

- **Humano (dev de Claudin)**: principal consumidor. CLI tipo `claudin
  tool-issues --since 7d` (sugerido em `04-report-tool-issue.md:21`)
  ou simplesmente `jq` no JSONL. Caso de uso: "modelo X reclama de
  schema do BashTool em 12 sessões — vou rever a descrição".
- **CLI agregador**: opcional, ROI baixo num primeiro release.
- **Outra LLM (`/resume`)**: NÃO. Reinjetar relatos no contexto da
  próxima sessão é exatamente o anti-pattern de poluir memória que
  motivou usar JSONL. Relatos são para o **humano**, não para o
  próximo turno.

## 4. Onde ganha de verdade

1. **Bash output filter escondendo sinal** — `bashOutputFilterEnabled`
   é default `true` (CLAUDE.md). Quando filtro come uma linha que o
   modelo precisava (regressão silenciosa), hoje o sinal se perde. Com
   a tool, modelo pode reportar "BashTool returned empty after filter
   for command `make test`" → dev investiga `docs/archive/discovery/bash-output-filter/`.
   Este é o **maior ganho real** observável.
2. **Plan mode bloqueando ação inesperada** — commit `330e6dc`
   (recente) tornou plan mode hard gate no engine. Quando modelo
   tenta tool não-allowlist e leva refusal, hoje só vê uma string de
   erro. Reportar via tool dá ao dev visibilidade de falsos positivos
   no gate sem precisar reproduzir.
3. **openai-compat com schema confuso** — `openaiShim.ts` (~2.2k
   linhas) é onde a maioria dos modelos não-Anthropic tropeça. Modelo
   GPT/Gemini interpretando mal `inputSchema` de uma tool seria
   capturado naturalmente como `wrong_schema | unclear_description`.
   Diferencial vs. Anthropic (que treina junto): essa população de
   bugs **só Claudin tem** — omp foca um modelo único.

## 5. Onde NÃO ganha ou pode dar errado

1. **Modelo nunca reporta** — risco real, depende muito do modelo.
   Modelos OpenAI-compat tendem a ser tímidos com tools meta. omp
   mitiga via `<critical>` no system prompt
   (`system-prompt.md:195-197`). Para Claudin default-off, ninguém vai
   ativar e nada é coletado. Ganho zero.
2. **Modelo reporta tudo (ruído)** — menos provável (omp documenta no
   deep-dive linhas 290-296: tool não dá recompensa, sem gradiente
   para over-report), mas modelos baratos podem usar como "desabafo
   barato". Mitigação herdada: cap 500 chars, sem rate limit
   necessário (não tem custo no loop).
3. **Storage cresce sem rotação** — JSONL append-only num projeto
   ativo pode chegar a MBs ao longo de meses. Rotação trivial por
   nome de arquivo (`YYYY-MM.jsonl`) resolve. Nenhum CLI de purge
   precisa existir no v1.
4. **Sanitização imperfeita vaza PII no próprio JSONL local** — risco
   baixo (é o disco do user) mas suja o dataset se o user um dia
   compartilhar manualmente. Sanitization de paths cobre 80%; resto é
   prompt-level discipline.

## 6. Comparação com alternativas

### `extractMemories` (já roda)

`EXTRACT_MEMORIES: true` em `build.ts:61`. Roda no **fim do turno**,
extrai memórias durables via subagente. Custo: tokens do subagente
extractor. Função: humano→agent, **não** agent→tool.

Em tese poderia ser ensinado a extrair tool issues, mas:
- Já gasta ~ 1-3k tokens por turno (cache hit dependente).
- Mistura dois eixos no mesmo prompt (preferences + bugs) degrada
  ambos.
- Saída é `.md` indexada em `MEMORY.md` — vide problema do tipo
  inadequado (seção 1).

**Não substitui.** Tool dedicada é ortogonal.

### Logs estruturados (`logForDebugging`)

Cobre debug do componente, não agregação cross-session indexada por
tool name. Dev teria que `grep` em STDERR de N sessões. Inferior.

### `src/services/extractMemories/`

Conforme acima, não cobre direção agent→tool feedback.

## 7. Veredito

**ROI**:

- **Esforço**: pequeno. Reusa `buildTool`, `getAutoMemPath`,
  `feature()` flag. Sem mudanças no contrato de `Tool.ts`. Sem novos
  endpoints. Sem alterações em `verify:privacy`. Estimo 1 file de tool
  + 1 patch em `tools.ts` + 1 patch em `build.ts` + 1 patch em prompt
  + testes. ~300-500 LOC.
- **Ganho**: depende do modelo. Anthropic-trained: alto (treinou para
  usar). OpenAI-compat: médio-baixo, viés a sub-reportar.
- **Risco**: baixo (local-only, fail-open, sem custo de tokens
  significativo).

**Default-off é prudente?** Sim, mas com asterisco. Default-off num v1
captura ZERO sinal — exatamente o problema do gap atual. Sugestão (sem
prescrever plano): flag em `build.ts` default `false`, mas settings
key `dev.reportToolIssue: true` por default em ambiente de dev
(`bun run dev`), ou ligar para o próprio repositório do Claudin via
`.claudin/settings.json` checked-in. Assim Anthropic-style "dogfooding"
acontece sem expor para usuários finais.

Vale a pena: **CONDICIONAL — porque** o encaixe arquitetural é limpo e
o esforço é pequeno, mas o ganho colapsa para zero se (a) default
permanece off em todo lugar OU (b) não houver consumidor humano (CLI
ou hábito de `jq`) que feche o loop. Sem (a) ou (b) resolvidos, é
infra sem usuário. Com ambos resolvidos, é o canal que falta para
capturar a categoria de bug que `extractMemories` e logs já não
capturam — especialmente nos pontos onde Claudin diverge de omp:
openai-compat schemas, bash filter, plan mode hard-gate.
