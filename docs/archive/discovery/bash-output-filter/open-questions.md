# Open Questions — decisões a fechar antes de codar

Cinco perguntas em aberto. Cada uma muda escopo em ordens de grandeza. Resposta esperada: discussão + decisão registrada no log do `README.md`.

---

## Q1. Formato dos filtros: TOML, JSON ou TS puro?

| Opção | Pró | Contra |
|---|---|---|
| **TOML** (cópia rtk) | Declarativo, autoexplicativo, copy-paste de exemplos funciona, comunidade rtk tem catálogo pronto | Nova dep (`smol-toml`), claudin só usa JSON em `~/.claudin/` hoje |
| **JSON em `settings.json`** | Zero deps, encaixa em `claudinMigration.ts`, schema com zod | Regex em string JSON é feio (escapes duplos), config grande fica ilegível |
| **TS built-in + JSON user override** | Built-ins expressivos (podem fazer parsing real), user mexe via JSON simples | Duas mentalidades pra manter |

**Inclinação atual:** TS built-in + JSON user. TOML só se quisermos paridade com rtk e PRs da comunidade direto em TOML.

**Pergunta direta:** começamos com (TS+JSON) e adicionamos TOML depois se demanda aparecer? Ou já investimos em TOML pra ter paridade com rtk desde o dia 1?

---

## Q2. Quantos filtros built-in na v1, e quais?

A tabela do rtk (README) sugere que ~80% do ganho vem de ~10 comandos: `git status`, `git diff`, `git log`, `ls`, `npm install`, `npm/yarn/pnpm test`, `cargo build/test`, `pytest`, `docker ps`, `find`. (`grep`/`rg` já têm GrepTool dedicado, então pular em Bash.)

**Tradeoff:**

- **Pipeline declarativo só** (como rtk faz com `jq`, `df`, `ps`): cobertura ampla com pouco código, mas teto baixo de redução (não consegue reformatar `ls -la` em árvore compacta).
- **Filtros nativos (parsing real)** tipo `cmds/system/ls.rs` do rtk com 471 linhas: 80%+ de redução em comandos chave, mas custo de manutenção alto.

**Opções concretas:**

- (a) v1 = **só pipeline declarativo**, 10 filtros builtin
- (b) v1 = **3 nativos** (`git status`, `git diff`, `ls -la`) + 7 declarativos
- (c) v1 = **só 5 nativos top**, declarativo só na v2

**Inclinação atual:** (b). Os 3 nativos são exatamente onde o pipeline declarativo dá teto baixo.

---

## Q3. Filtros de projeto na v1?

`.claudin/filters.json` no repo permite cada time customizar (ex: time tem um wrapper de teste com banner de 50 linhas que ninguém precisa).

Mas é a **maior superfície de ataque**: PR malicioso commita filtro que esconde "deletei seu .ssh/" do output do bash. rtk levou isso a sério com SHA-256 trust + dialog de aprovação.

**Opções:**

- (a) **v1 só built-in + user-global** (`~/.claudin/filters.json`). Filtros de projeto fica pra v2.
- (b) **v1 com filtros de projeto + trust dialog** (paralelo direto do `mcpServerApproval`).

**Inclinação atual:** (a) conservador. Filtros de projeto são a feature "killer" do rtk, mas trazer trust system é trabalho real e vale ver se user-global resolve antes de assumir o custo.

---

## Q4. Default on ou opt-in inicial?

- **Default on** (`bashOutputFilterEnabled: true`): adoção máxima, mas qualquer regressão silenciosa atinge todo mundo.
- **Opt-in via `/provider` ou env var**: zero risco, mas adoção lenta. Histórico do projeto: streaming-highlight foi default-on (CLAUDE.md menciona `CLAUDIN_DEFER_HIGHLIGHT=0` para reverter).

**Tradeoff específico:** o `toolResultSummarizer` JÁ é default-on com kill switch, e nunca vimos issue dele. Se o filtro novo seguir o mesmo padrão de "fail open + log + kill switch", default-on é defensável.

**Inclinação atual:** default-on, com:
- `CLAUDIN_DISABLE_BASH_OUTPUT_FILTER=1` para kill switch global
- `bashOutputFilterEnabled: false` em `~/.claudin/settings.json` para opt-out persistente
- `CLAUDIN_BASH_FILTER_DEBUG=1` para o usuário ver antes/depois quando algo parecer estranho

---

## Q5. Comando `/savings` ou `/gain` na v1?

rtk tem `rtk gain` mostrando cumulative savings. Sem isso, usuário não confia: "filtrou alguma coisa importante?". Hoje o summarizer só loga via `logEvent('claudin_tool_result_summarized', ...)` que ninguém vê.

**Opções:**

- (a) **Nada na v1.** Footer no marker `<bash-output-filtered name="..." reduction="N%">` já dá visibilidade pro modelo (e indiretamente pro usuário olhando a transcrição).
- (b) **Comando `/savings` na v1** mostrando tabela acumulada por sessão.
- (c) **Integrar no `/usage` ou `/cost` existentes.**

**Inclinação atual:** (a) na v1, (c) na v2. Marker já é diagnostic suficiente; comando dedicado é polish que não bloqueia ROI.

---

## Plano de validação Fase 0 (instrumentação quantitativa)

Antes de qualquer código de filtro, queremos responder com dados:

### Pergunta 1: Quais comandos dominam o uso real de Bash?

**Hipótese:** top-10 do rtk casa com top-10 do claudin.
**Risco se hipótese falhar:** investimos em filtros de comandos que ninguém usa.

**Instrumentação:**
- Adicionar `logEvent('claudin_bash_command_first_verb_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS', { verb, outputBytes, exitCode })` em `BashTool.call()`.
- `verb` = primeiro token do `splitCommand_DEPRECATED(input.command)[0]`, sanitizado (só nomes de comandos conhecidos passam, resto vira `_other_`).
- Rodar 1 semana em uso pessoal + pedir 3-5 contributors pra rodar também.
- Top-20 verbos por count e por bytes acumulados.

### Pergunta 2: Qual a distribuição de tamanhos?

**Hipótese:** mediana de `git status` é >500 bytes (vale filtrar), mas mediana de `cat` é >5KB (já cai no summarizer).
**Risco se hipótese falhar:** filtros caros pra outputs minúsculos.

**Instrumentação:** mesmo evento de cima já capta `outputBytes`. Análise: histograma por verbo.

### Pergunta 3: Quantas regressões silenciosas?

**Hipótese:** zero ou perto disso, com fallback "skipa em is_error".
**Risco:** filtro engole linha que o modelo precisava.

**Validação:**
- Rodar agente em 100 conversas reais com filtro on/off (toggle por turno).
- Pedir o mesmo modelo (provider determinístico, ex: Anthropic com temperature=0) para resolver a mesma task.
- Diff de comportamento: o agente fez perguntas extras? Errou onde antes acertava?
- Não-automatizável 100%, precisa eyeballing.

### Saída esperada

Atualizar `analysis.md` com:
- Tabela "top-20 verbos no claudin" (real data, não tabela rtk)
- Histograma de tamanhos por verbo
- Recomendação revisada de quais filtros priorizar na v1

**Custo estimado Fase 0:** 2 dias de instrumentação + 1 semana de coleta + 1 dia de análise. ~2 semanas calendar.

**Alternativa "quick & dirty":** pular Fase 0, fazer MVP com top-10 do rtk, medir empiricamente em produção via os mesmos eventos. Custo: risco de filtros desperdiçados, mas economiza 2 semanas.

---

## Sumário pra decisão

| # | Pergunta | Inclinação | Custo se errar |
|---|---|---|---|
| 1 | Formato | TS+JSON | Médio — migrar formato depois é chato mas factível |
| 2 | Quantidade builtin | 3 nativos + 7 declarativos | Baixo — fácil adicionar mais |
| 3 | Filtros de projeto na v1 | Não | Baixo — feature add, não breaking |
| 4 | Default on/off | Default on com kill switch | Alto — regressão silenciosa atinge todos |
| 5 | `/savings` na v1 | Não, só marker | Baixo — comando é polish |
| 6 | Fase 0 instrumentação | Sim, 2 semanas | Médio — sem dados, otimizamos no escuro |

**Bloqueador real:** Q1 (formato) e Q6 (Fase 0 ou não). Sem essas duas fechadas, não vale começar a escrever código.
