# Deep dive — `report_tool_issue` (self-feedback tool)

## Resumo executivo

`omp` expõe ao modelo uma meta-tool `report_tool_issue` que serve como canal
de QA automatizado: sempre que uma chamada de outra tool produz resultado
estranho/incoerente com a descrição, o agente registra uma "grievance"
contra a tool ofensora. O tooling é construído por turno (enum dinâmico
restrito aos built-ins ativos), grava em SQLite local
(`~/.omp/agent/autoqa.db`) e — somente com consentimento explícito do
usuário — faz push para um endpoint central. O design tem três aspectos
notáveis: (1) save é incondicional (usuário sempre dono do próprio dado),
(2) ship é gated por consent dialog single-flight com persistência em
settings, (3) o "spam" do modelo é absorvido com `Noted, thanks!` e
silent-drop para tools fora do allowlist — sem rate-limit, sem custo no
loop, sem erro de volta.

Para Claudin o ganho é simétrico: hoje o feedback flui só humano→agente,
e o agente jamais sinaliza "a descrição da tool X me confundiu" ou "o
filtro de bash escondeu sinal que eu precisava". Encaixa em
`src/tools/ReportToolIssueTool/`, grava em `~/.claudin/projects/<dir>/memory/tool-issues/`
(uma linha JSONL por relato, NÃO `.md` por arquivo — relatos são append-only
e não devem virar memórias indexadas), atrás de feature flag
`REPORT_TOOL_ISSUE`. Sem push remoto, sem consent dialog — Claudin é
local-only por design. Privacidade é o ponto crítico (paths/snippets
podem vazar no campo `report`), tratado por (a) prompt que proíbe PII e
(b) sanitização defensiva no execute path antes do write.

## Como omp implementa

Arquivos de referência (oh-my-pi):

- `packages/coding-agent/src/tools/report-tool-issue.ts:30-41` — schema
  builder. `tool` é `z.enum([...activeBuiltinNames])` quando há nomes;
  fallback para `z.string()` quando o caller não conhece o set ativo
  (subagents, etc.). `report` é `z.string()` com `.describe(...)`
  proibindo PII (paths, file contents, identifiers, prompt text).
- `report-tool-issue.ts:458-470` — factory `createReportToolIssueTool`
  recebe a `session` e a lista de built-ins ativos no turno. O enum é
  snapshot na construção; mid-session drift cai no silent-drop.
- `report-tool-issue.ts:472-525` — execute path. Save é incondicional
  (`INSERT INTO grievances`). `proxy_<name>` prefix é stripped antes do
  allowlist check (`:484`). Tools fora do allowlist (MCP, extensões,
  typos) são silenciosamente aceitos com `Noted, thanks!` — **não
  retorna erro ao modelo** (`:490-492`). Após o insert, dispara em
  background `resolveAutoQaConsent` + `flushGrievances` via
  `void (async () => {...})()` — execute volta imediato (`:510-517`).
- `report-tool-issue.ts:43-45` — `isAutoQaEnabled` gate: `$flag("PI_AUTO_QA")`
  OR `settings.get("dev.autoqa")`. Default `false` (settings-schema.ts:2716-2724).
- `report-tool-issue.ts:68-184` — consent system. Process-global cache
  + single-flight (`consentInFlight`) garante UM popup mesmo com
  subagents disparando concorrentemente. Estados persistidos:
  `"unset" | "granted" | "denied"` em `dev.autoqa.consent`. ESC/null
  NÃO persiste (re-prompt na próxima) — só Yes/No grava.
- `report-tool-issue.ts:204-238` — schema SQLite: `grievances(id, model,
  version, tool, report, pushed)`. WAL mode, índice em `(pushed, id)`.
  Migration idempotente adiciona `pushed` em DBs antigos.
- `report-tool-issue.ts:310-327` — `resolvePushConfig` separa save de
  ship. Consent OR `PI_AUTO_QA_PUSH` flag, mais endpoint configurado.
- `report-tool-issue.ts:337-410` — `performFlush`: batch de 50,
  fetch com `AbortSignal.timeout(5_000)`, marca `pushed=1` por `id IN
  (?, ?, ...)` (não range — inserts concorrentes não são roubados).
  Payload inclui `installId`, `platform`, `arch` (fingerprint coarse
  para triage; o pré-anterior mandava `os.hostname()` e foi removido
  por deanonimização trivial — comentário `:357-359`).
- `report-tool-issue.ts:419-456` — `flushGrievances` single-flight com
  `FAILURE_COOLDOWN_MS = 30_000` após falha. Auto-flush respeita o
  cooldown; `bypassConsent` (CLI manual push) ignora.
- `packages/coding-agent/src/tools/index.ts:513-528` — injeção
  automática: se `isAutoQaEnabled`, adiciona a tool em TODOS os agentes
  (incluindo subagents), independente do tool selection. `activeBuiltinNames`
  derivado dos tools que já foram construídos via `BUILTIN_TOOLS`/`HIDDEN_TOOLS`,
  excluindo MCP/extensões.
- `packages/coding-agent/src/session/agent-session.ts:3266-3272` —
  guarda runtime contra tool-set mutation: se autoqa habilitado e
  `report_tool_issue` saiu do `validToolNames`, re-injeta.
- `packages/coding-agent/src/prompts/system/system-prompt.md:194-198` —
  prompt section condicionalmente renderizada via `{{#has tools "report_tool_issue"}}`:
  > "If ANY tool you call returns output that is unexpected, incorrect,
  > malformed, ... call `{{toolRefs.report_tool_issue}}` ... Do not
  > hesitate to report — **false positives are acceptable**."

### Rate-limiting / anti-spam

Não existe rate-limit explícito. As defesas são todas estruturais:

1. **Custo é silencioso** — execute volta `Noted, thanks!` em
   constant-time; modelo não recebe erro nem feedback negativo, então
   "reclamar" não consome contexto extra além do próprio tool call.
2. **Allowlist silent-drop** — abusos contra tools desconhecidas viram
   no-op (`:490-492`). Sem retorno acionável, modelo não aprende a
   continuar.
3. **DB local sempre aceita** — nada é descartado por volume; usuário
   consome via `omp grievances` CLI.
4. **Push tem cooldown** (`FAILURE_COOLDOWN_MS=30s`) e single-flight,
   mas isso protege o BACKEND, não limita o modelo.

Ou seja, o design aposta em: "let it be noisy locally; sample/analyze
offline; o ship é gated por consent + batch + cooldown".

## Onde encaixar em Claudin

### Estrutura sugerida

```
src/tools/ReportToolIssueTool/
├── index.ts              ← buildTool, factory, zod schema dinâmico
├── ReportToolIssueTool.ts ← exec path + sink
├── sink.ts               ← write JSONL append-only
├── sanitize.ts           ← strip paths/snippets defensivos
├── prompt.ts             ← prompt section condicional
└── ReportToolIssueTool.test.ts
```

Tool registration: igual aos demais, em `src/tools/index.ts` (ou onde
o registry é composto). Gating por `feature('REPORT_TOOL_ISSUE')` em
`scripts/build.ts` (default OFF até validar UX).

### Schema sugerido (zod)

```ts
// Construído por turno, recebendo o set ativo
function buildSchema(activeToolNames: readonly string[]) {
  const toolSchema =
    activeToolNames.length > 0
      ? z.enum(activeToolNames as [string, ...string[]])
      : z.string()

  return z.object({
    tool: toolSchema.describe('Name of the tool that misbehaved'),
    category: z.enum([
      'unclear_description',   // schema/description ambíguo
      'wrong_schema',          // input shape não bate com o que a tool aceita
      'unexpected_output',     // output diferente do prometido
      'missing_param',         // parâmetro óbvio ausente do schema
      'permission_friction',   // tool bloqueia sem caminho claro de fix
      'filter_hid_signal',     // bashOutputFilter escondeu output relevante
      'other',
    ]).describe('Category of the issue'),
    description: z.string()
      .min(10)
      .max(500)
      .describe(
        'Generic description. NEVER include file paths, file contents, ' +
        'identifiers, user prompt text, or secrets. Describe the SHAPE ' +
        'of the problem, not the data.'
      ),
  })
}
```

A categoria `filter_hid_signal` é específica de Claudin (engata com
`bashOutputFilterEnabled` — feedback loop direto sobre quando o filtro
prejudica). `permission_friction` capta o que omp não tem mas Claudin
tem muito (plan mode hard gate, sandbox).

A construção do enum por turno espelha omp: a factory recebe a lista
de tools ativas (que muda com plan mode, coordinator, sandbox, etc.),
e o enum é snapshot. Drift (MCP carregando depois) cai no silent-drop.

### Destino: JSONL append-only

**Recomendado:** JSONL append-only em `~/.claudin/projects/<dir>/memory/tool-issues.jsonl`,
**NÃO** um `.md` por relato dentro de `memory/`.

Justificativa:

1. **Memórias têm taxonomia rígida** (`MEMORY_TYPES = ['user',
   'feedback', 'project', 'reference']` em `src/memdir/memoryTypes.ts:14-19`).
   "Tool issue" não é nenhum desses — é dado operacional, não
   conhecimento sobre o projeto/usuário.
2. **MEMORY.md index é semântico, não cronológico.** Cada `.md` tem
   frontmatter `name`/`description`/`type` e é considerado pelo
   `findRelevantMemories` no system prompt. Despejar 50 relatos de
   "Bash filter escondeu output" polui o índice e gasta tokens em
   todo turno.
3. **JSONL é o formato natural para logs append-only** que serão
   consumidos offline. Uma linha por relato:
   `{"ts":"2026-05-25T...","model":"...","tool":"BashTool","category":"unexpected_output","description":"..."}`.
4. **Pasta `memory/` ainda é o lar correto** (per-project, já é
   gitignorado, já tem o ciclo de vida certo), só não como `.md`
   indexado.

Alternativa: `~/.claudin/projects/<dir>/tool-issues.jsonl` (fora de
`memory/`). Trade-off: perde a co-localização com o resto da memória
do projeto, ganha separação clara de domínio. Eu ficaria com o
caminho dentro de `memory/` mas como `.jsonl` plano — o memdir scan
hoje só ingere `.md` (`src/memdir/memoryScan.ts` filtra por extensão),
então não vai entrar no índice por acidente.

Schema da linha JSONL:

```ts
type ToolIssueRecord = {
  ts: string              // ISO 8601
  sessionId: string       // session id (não user id)
  model: string           // getPrimaryModel() resolved name
  provider: string        // active provider key
  tool: string            // tool name (canonicalized, sem proxy_)
  category: string        // enum acima
  description: string     // sanitized
  agentVersion: string    // MACRO.DISPLAY_VERSION
}
```

Append via `fs.appendFile(path, JSON.stringify(record) + '\n')` —
sem locking explícito (POSIX `O_APPEND` é atômico até PIPE_BUF, e
linhas JSONL ficam tranquilamente abaixo disso).

### Privacidade

Este é o ponto onde Claudin diverge fundamentalmente de omp. omp pode
shippar pro `qa.omp.sh`; Claudin não shippa pra lugar nenhum. Mas
mesmo só gravando localmente, o relato é texto livre que o modelo
escreveu — pode conter path absoluto, snippet de código, nome de função
proprietária, conteúdo de `~/.claudin/settings.json` (se um relato for
sobre `ConfigTool`).

Defesas em camadas:

1. **Prompt explícito** — section condicional segue o omp template
   ("describe the SHAPE of the problem, not the data") + lista
   explícita do que não pode entrar.
2. **Sanitização defensiva no execute path** — antes do write, passa
   `description` por sanitizador que:
   - Substitui paths absolutos por `<path>` (regex tipo `\/(?:home|Users|root|var|etc|tmp)\/\S+` e Windows `[A-Za-z]:\\\S+`).
   - Strip blocks ` ```...``` ` e ` `...` ` inline.
   - Substitui sequências longas de hex/base64 (`>=20` chars) por
     `<hash>`.
   - Trunca em 500 chars (já enforced pelo zod, mas redundante).
3. **`verify:privacy` integration** — a tool em si **não** introduz
   nenhuma chamada de rede, então não precisa de novo pattern banido.
   Mas adicionar um sanity test em
   `scripts/no-telemetry-growthbook-stub.test.ts` ou similar
   garantindo que `ReportToolIssueTool` nunca chama `fetch` é barato e
   à prova de regressão.
4. **Sem `installId`/`hostname`/`platform` no record** — diferente do
   payload de push omp (`report-tool-issue.ts:354-362`), Claudin não
   precisa fingerprint nenhum. `sessionId` é interno e suficiente para
   correlacionar com `~/.claudin/logs/`.

Conflito direto com `verify:privacy`: nenhum. O script
(`scripts/verify-no-phone-home.ts:6-18`) checa o bundle por strings
banidas (datadog, endpoints internos, etc.). Como a tool é write-only
local, não introduz nada na lista. **Se** for adicionado push opcional
no futuro, o endpoint default precisa entrar no banlist (ao contrário
de omp, que tem endpoint default ativo).

### Feature flag

`feature('REPORT_TOOL_ISSUE')` em `scripts/build.ts`, **default OFF**
no primeiro release. Razões:

1. Não está claro que o sinal vale o ruído antes de validação.
2. Modelos OpenAI-compatible podem ignorar o enum (`openaiShim.ts`
   traduz, mas o respect do enum varia) — quero observar primeiro com
   um subset de usuários.
3. Default OFF é coerente com `EXTRACT_MEMORIES` e similares (também
   começaram OFF).

Quando ON, a tool é injetada em todos os agentes (main + sub-agents
via `AgentTool`), espelhando omp (`tools/index.ts:516-527`). Nunca é
sujeita a tool selection no prompt — é meta-infra.

Setting de runtime: `~/.claudin/settings.json` ganha
`reportToolIssue.enabled: boolean` (default `false` mesmo com flag
ON, opt-in explícito) e `reportToolIssue.path: string` (override do
destino do JSONL, default `~/.claudin/projects/<dir>/memory/tool-issues.jsonl`).
Não precisa de `consent` enum (omp precisa porque ship é remoto).

### Como o humano consome

Três caminhos, dos quais o (1) é o mvp:

1. **Slash command `/tool-issues`** dentro do REPL — lista os relatos
   recentes, com flags `--since 7d`, `--tool BashTool`,
   `--category filter_hid_signal`. Lê o JSONL, agrupa por tool+category,
   imprime contagem + amostras. Vive em `src/commands/tool-issues/`.
2. **`grep` manual no JSONL** — sempre disponível, formato é texto.
3. **CLI subcommand `claudin tool-issues`** (out of REPL) — mais
   adiante, para análise em batch. Pode entrar no mesmo subcomando
   tipo `claudin tool-issues export --json`.

Não há equivalente ao `omp grievances push` — não há push, ponto.

### Risco: modelo abusar da tool para "reclamar"

Real, mas as mitigações herdadas de omp + ajustes pra Claudin cobrem:

1. **Custo no modelo é mínimo** — tool call → resposta curta
   ("Noted.") → próximo turno. Modelo não "ganha" nada chamando, então
   não há gradient para over-trigger.
2. **Sem feedback acionável** — diferente de uma tool que retorna
   estado mutável, esta sempre retorna a mesma string. Não há loop
   onde o modelo aprende a chamar mais.
3. **Prompt fala "false positives são aceitáveis"** — invertendo o
   risco normal (que seria modelo não reportar por medo de errar).
   Trade-off explícito: ruído > silêncio.
4. **Janela de 500 chars no description** — limita o blast radius.
5. **Quota opcional futura** — se observarmos abuse na prática,
   adicionar contador em memória "max N reports/turno" e silent-drop
   o resto é trivial. omp não precisou; provavelmente Claudin também
   não.
6. **Custo de tokens é real**: cada tool call gasta ~150 tokens
   ida+volta. A 10 reports/sessão isso é ~1.5k tokens, irrelevante
   frente ao ganho de sinal. A 100+, vira sinal de bug (ou no modelo,
   ou na tool). O `/tool-issues` command deve mostrar essa métrica
   para o humano notar.

O risco maior, na verdade, é o oposto: modelo NUNCA chamar a tool
mesmo quando deveria. omp resolveu isso colocando a section no
prompt como `<critical>` (system-prompt.md:195-197). Claudin deve
fazer igual.

## Arquivos relevantes (refs)

omp:
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/tools/report-tool-issue.ts`
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/tools/index.ts:513-528`
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/session/agent-session.ts:3266-3272`
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/prompts/system/system-prompt.md:194-198`
- `/home/dev/projects/oh-my-pi/packages/coding-agent/src/config/settings-schema.ts:2716-2759`
- `/home/dev/projects/oh-my-pi/packages/coding-agent/test/tools/report-tool-issue-consent.test.ts`

Claudin (onde encaixar):
- `/home/dev/projects/claudin/src/Tool.ts` — `buildTool`, `ToolDef`, `ToolUseContext` (símbolos linhas 748-823)
- `/home/dev/projects/claudin/src/memdir/paths.ts` — `getAutoMemPath()` para destino do JSONL
- `/home/dev/projects/claudin/src/memdir/memoryTypes.ts:14-19` — taxonomia de memória (porque NÃO usar `.md`)
- `/home/dev/projects/claudin/src/memdir/memoryScan.ts` — confirma filtragem por extensão (`.jsonl` não é ingerido como memória)
- `/home/dev/projects/claudin/scripts/build.ts` — featureFlags (adicionar `REPORT_TOOL_ISSUE`)
- `/home/dev/projects/claudin/scripts/verify-no-phone-home.ts:6-18` — banlist (nada a adicionar enquanto for local-only)
- `/home/dev/projects/claudin/src/tools/BashTool/` — exemplo canônico de estrutura de tool
