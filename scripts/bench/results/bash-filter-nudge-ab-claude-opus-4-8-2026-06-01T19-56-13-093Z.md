# Bench A/B — BashTool output-filter nudge

- Timestamp: 2026-06-01T19:56:13.093Z
- Model: `claude-opus-4-8`
- Baseline: `/tmp/bench_baseline/cli.mjs`
- Feature:  `/tmp/bench_feature/cli.mjs`
- Runs por prompt: 2

## Tabela por invocacao

| Prompt | V | Run | OK | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Bash atom/comp | Session |
|---|---|---:|:-:|---|---:|---:|---:|---|---|---|
| recent-changes-summary | A | 1 | Y | 6/618/68279 | 0.2167 | 15.9 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | e1e9ff3a |
| recent-changes-summary | B | 1 | Y | 6/638/68645 | 0.2174 | 17.6 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 1aeb1a40 |
| diff-impact-then-detail | A | 1 | Y | 595/1036/39940 | 0.2092 | 16.1 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 93c13543 |
| diff-impact-then-detail | B | 1 | Y | 4/1246/40188 | 0.2176 | 18.7 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 5ee3a226 |
| tree-overview | A | 1 | Y | 4/285/39917 | 0.1916 | 7.9 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 1/0 (trunc=0) | 09fc11fc |
| tree-overview | B | 1 | Y | 4/313/40165 | 0.1924 | 8.7 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 1/0 (trunc=0) | b29622e3 |
| deps-question | A | 1 | Y | 4/113/39901 | 0.1759 | 6.3 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 0/1 (trunc=0) | 0f25e897 |
| deps-question | B | 1 | Y | 4/217/40149 | 0.1796 | 8.1 | 2 | Bash=0 Read=0 Grep=1 Glob=0 | 0/0 (trunc=0) | 5244f784 |
| env-then-config | A | 1 | Y | 4/253/39902 | 0.2079 | 7.3 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 270a2b20 |
| env-then-config | B | 1 | Y | 4/243/40150 | 0.2076 | 8.9 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 52272102 |
| recent-changes-summary | A | 2 | Y | 6/556/83479 | 0.0704 | 12.8 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 727e4816 |
| recent-changes-summary | B | 2 | Y | 6/633/84657 | 0.0651 | 16.0 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | ade6288d |
| diff-impact-then-detail | A | 2 | Y | 595/1262/55182 | 0.0702 | 19.3 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 1dab725a |
| diff-impact-then-detail | B | 2 | Y | 595/1261/55430 | 0.0703 | 19.5 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 30a4bc6d |
| tree-overview | A | 2 | Y | 4/336/55136 | 0.0484 | 8.7 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 1/0 (trunc=0) | 3a461a9a |
| tree-overview | B | 2 | Y | 4/264/55384 | 0.0466 | 8.8 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 1/0 (trunc=0) | 484047b4 |
| deps-question | A | 2 | Y | 4/207/55104 | 0.0346 | 6.6 | 2 | Bash=0 Read=0 Grep=1 Glob=0 | 0/0 (trunc=0) | 16d1ac87 |
| deps-question | B | 2 | Y | 4/129/55352 | 0.0321 | 8.2 | 2 | Bash=1 Read=0 Grep=0 Glob=0 | 1/0 (trunc=0) | b8fe01bd |
| env-then-config | A | 2 | Y | 4/251/55106 | 0.0633 | 7.8 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | 94fd7ff7 |
| env-then-config | B | 2 | Y | 4/251/55354 | 0.0633 | 11.4 | 3 | Bash=2 Read=0 Grep=0 Glob=0 | 2/0 (trunc=0) | c54db399 |

## Sumario

### A (baseline) (n=10)

- Avg duration: 10.88s
- Avg input tokens: 123
- Avg output tokens: 492
- Avg cache-read tokens: 53195
- Avg cache-creation tokens: 8931
- Avg cost: $0.1288 (total $1.2882)
- Avg turns: 2.6
- Tool call totals: Bash=15 Read=0 Grep=1 Glob=0
- Bash totals: 15 (atomic=14, compound=1, 6.7% composto)
- **Pipe->truncator (head/tail/cat): 0 (0.0% dos Bash)** [KPI focado do nudge]

### B (feature) (n=10)

- Avg duration: 12.59s
- Avg input tokens: 64
- Avg output tokens: 520
- Avg cache-read tokens: 53547
- Avg cache-creation tokens: 8914
- Avg cost: $0.1292 (total $1.2922)
- Avg turns: 2.6
- Tool call totals: Bash=15 Read=0 Grep=1 Glob=0
- Bash totals: 15 (atomic=15, compound=0, 0.0% composto)
- **Pipe->truncator (head/tail/cat): 0 (0.0% dos Bash)** [KPI focado do nudge]

### Delta

- **Pipe->truncator: 0 -> 0** (rel 0.0%) [KPI primario]
- % composto (contexto): 6.7% -> 0.0% (abs -6.7pp)
- Bash compound: 1 -> 0
- Avg input tokens delta: -48.2%
- Avg cost delta: 0.3%

### Kill criteria

- KPI = numero de pipes para head/tail/cat (o bypass exato que o nudge ataca).
- SHIP se B reduz pipe->truncator em >=30% rel E avg cost nao piora (<+5%).
- KILL se reducao <30% rel (nudge inerte) OU se cost piora >+5%.
- NOTA: n=5x2 e sinal preliminar. Regra de time: >=3 replicacoes antes de decidir.

- Veredito: **INERT/REVERT (preliminar)**
  - pipe->truncator delta rel: 0.0% (fail)
  - cost delta: 0.3% (OK)

## Comandos Bash observados

### Variante A

**recent-changes-summary run#1** (atomic=2, compound=0):

- [A] `git log --stat -20`
- [A] `git log --pretty=format:"%h %s" -20`

**diff-impact-then-detail run#1** (atomic=2, compound=0):

- [A] `git diff --stat HEAD~5 HEAD`
- [A] `git log --oneline -20`

**tree-overview run#1** (atomic=1, compound=0):

- [A] `ls -R src/services/api`

**deps-question run#1** (atomic=0, compound=1):

- [C] `cat package.json | grep -i zod`

**env-then-config run#1** (atomic=2, compound=0):

- [A] `git config --list`
- [A] `git remote -v`

**recent-changes-summary run#2** (atomic=2, compound=0):

- [A] `git log --stat -20`
- [A] `git log --oneline -20`

**diff-impact-then-detail run#2** (atomic=2, compound=0):

- [A] `git diff --stat HEAD~5 HEAD`
- [A] `git log --oneline -20`

**tree-overview run#2** (atomic=1, compound=0):

- [A] `ls -R src/services/api`

**env-then-config run#2** (atomic=2, compound=0):

- [A] `git config --list`
- [A] `git remote -v`

### Variante B

**recent-changes-summary run#1** (atomic=2, compound=0):

- [A] `git log --stat -20`
- [A] `git log -20 --pretty=format:'%h %s'`

**diff-impact-then-detail run#1** (atomic=2, compound=0):

- [A] `git diff --stat HEAD~5 HEAD`
- [A] `git log --oneline -20`

**tree-overview run#1** (atomic=1, compound=0):

- [A] `ls -R src/services/api`

**env-then-config run#1** (atomic=2, compound=0):

- [A] `git config --list`
- [A] `git remote -v`

**recent-changes-summary run#2** (atomic=2, compound=0):

- [A] `git log --stat -20`
- [A] `git log --oneline -20`

**diff-impact-then-detail run#2** (atomic=2, compound=0):

- [A] `git diff --stat HEAD~5 HEAD`
- [A] `git log --oneline -20`

**tree-overview run#2** (atomic=1, compound=0):

- [A] `ls -R src/services/api`

**deps-question run#2** (atomic=1, compound=0):

- [A] `grep '"zod"' package.json`

**env-then-config run#2** (atomic=2, compound=0):

- [A] `git config --list`
- [A] `git remote -v`

## Outputs (resultText) lado a lado

### recent-changes-summary

> Olhe os 20 commits mais recentes deste repo com `git log --stat -20` e me resuma em 3 bullets o que andou mudando por aqui ultimamente. Nao precisa listar commit por commit.

**Variant A run#1:**

```
Aqui vão os 3 temas que dominaram os últimos 20 commits:

- **Performance e robustez de startup/API** — lazy-load de módulos de tools com sobreposição de init, cache do SDK client por chave composta com dedup single-flight, resolução do transport uma vez por retry loop, e dedup no refresh de token do GitHub Copilot. Lançadas as releases v0.5.1 e v0.5.2 no meio disso.

- **Picker de modelo e contexto de 1M** — o `/model` passou a oferecer variantes de 200k e 1M, com label "(1M context)" sempre anotado nos modelos `[1m]`, mais correção para não ressurgir o modelo do profile por cima da escolha "Default" do projeto.

- **Polimento de TUI e estabilidade de streaming** — ajustes visuais (spine em árvore no `/context`, skills bundladas listadas, padding do logo, remoção do clear de terminal no launch) e o watchdog de idle de streaming ligado por padrão (65s) para recuperar streams travados. Fechando, trabalho de bench/prompts em torno do filtro de output do Bash.
```

**Variant A run#2:**

```
Olhei os 20 commits. Resumo do que andou mudando:

- **Performance e robustez de provider/streaming**: cache do SDK client por chave composta com dedup single-flight, resolução de transporte uma vez por retry loop, dedup no refresh de token do GitHub Copilot, e o idle watchdog de streaming ligado por padrão (65s) pra recuperar streams travados.
- **UX do picker de modelo e telas de startup/context**: variantes de contexto 200k + 1M no `/model` (com label "(1M context)"), spine de árvore conectada no `/context`, fix pra listar skills bundled, e vários ajustes de startup (lazy-load de tools, não limpar terminal no launch, padding do logo, escolha de modelo do profile vs "Default").
- **Releases e tuning de prompts/bench**: cortes de releases v0.5.1 e v0.5.2, nudge nos prompts contra pipar saída do Bash pra head/tail/cat, e resultados de benchmark de cache-progression adicionados.
```

**Variant B run#1:**

```
Aqui vai o resumo dos últimos 20 commits:

- **Performance e robustez do agent loop / API.** Caching do SDK client por chave composta com single-flight dedup, resolução de transporte uma vez por retry loop, eliminação de construção desnecessária de schema de `specialTools`, dedup no refresh de token do GitHub Copilot, e o idle watchdog de streaming ligado por padrão (65s) pra recuperar streams travados — além de dois releases (v0.5.1, v0.5.2).

- **Polimento da TUI de startup e seleção de modelo.** Lazy-load de módulos de tool com init antecipado, parar de limpar o terminal no launch, trim no padding/logo, e no `/model` picker ganhou variantes de contexto 200k + 1M com label "(1M context)" sempre anotado; também correções de prioridade de modelo de profile vs. "Default" do projeto.

- **Ajustes finos em `/context`, prompts e bench.** Spine de árvore conectada nas listas do `/context`, skills bundled aparecendo na listagem, nudge nos prompts contra pipar saída de Bash pra head/tail/cat,
…[truncado]
```

**Variant B run#2:**

```
Olhando os 20 commits mais recentes, aqui está o resumo do que andou mudando:

- **Performance e robustez do startup/API** — vários `perf`/`refactor`: cache de SDK client por chave composta com dedup single-flight, resolução de transporte uma vez por retry loop, lazy-load de módulos de tools com init antecipado, dedup no refresh de token do GitHub Copilot, e watchdog de stream ocioso ligado por padrão (65s) pra recuperar streams travados.

- **Melhorias de UX no /model e /context** — picker de modelo agora oferece variantes de 200k e 1M de contexto (com label "(1M context)"), `/context` ganhou spine de árvore conectado e passou a listar skills bundladas, além de correção pra não ressurgir modelo do profile sobre o "Default" do projeto.

- **Polimento de startup e benchmarks** — limpeza da tela de inicialização (sem padding em branco, sem limpar terminal no launch, logo mais enxuto) e bastante trabalho de bench/tuning do filtro de output do Bash (nudge contra pipe pra head/tail/cat, res
…[truncado]
```

### diff-impact-then-detail

> Rode `git diff --stat HEAD~5 HEAD` para ver o que mudou nas ultimas 5 revisoes e me diga qual arquivo foi o mais alterado. Depois rode `git log --oneline -20` e confirme se essas mudancas estao todas no mesmo tema.

**Variant A run#1:**

```
Pronto. Resultado:

## Arquivo mais alterado

Por linhas modificadas, o campeão entre arquivos de **código-fonte** é:

- **`src/utils/model/modelOptions.ts`** — 111 linhas (`+58/−53`, é uma reescrita substancial da lógica de opções de modelo).

Se contarmos linhas brutas no diff inteiro, o topo absoluto é `scripts/bench/cli-token-footprint.sh` (158) e os arquivos de resultado de bench, mas esses são scripts/artefatos de benchmark, não a mudança "real". Entre os fontes que importam, `modelOptions.ts` lidera, seguido de perto por `ContextVisualization.tsx` (60) e os testes novos `modelOptions.dualcontext.test.ts` (99) e `modelProjectPersistence.test.ts` (73).

## As 5 revisões são do mesmo tema?

**Maioria sim, mas não todas.** Os 5 commits (`HEAD~5..HEAD`) são:

| Commit | Tema |
|--------|------|
| `31128c9` feat(model): 200k + 1M context variants no /model picker | **modelo** ✅ |
| `631f667` fix(model): anotar "(1M context)" em labels [1m] | **modelo** ✅ |
| `2f87c82` chore(bench): ca
…[truncado]
```

**Variant A run#2:**

```
## `git diff --stat HEAD~5 HEAD`

O arquivo mais alterado em volume de linhas é **`scripts/bench/cli-token-footprint.sh`** com **158 linhas** modificadas (o maior `churn` entre todos). Logo atrás vêm `scripts/bench/cache-progression.sh` (149, arquivo novo) e os arquivos de resultado de bench gerados (~120 linhas cada).

Entre os arquivos de **código-fonte** (não-bench), o mais alterado é **`src/utils/model/modelOptions.ts`** com 111 linhas.

## `git log --oneline -20` — confirmação de tema

As últimas 5 revisões (`HEAD~5..HEAD`) **não são todas do mesmo tema** — há dois temas misturados:

1. **`/model` e contexto 1M/200k** (o maior bloco):
   - `631f667 fix(model): always annotate "(1M context)"...`
   - `31128c9 feat(model): offer 200k + 1M context variants...`
   - `bd8150d style(context): draw connected tree spine...`
   - Isso bate com os arquivos `src/utils/model/*`, `src/commands/model/model.tsx`, `src/components/ContextVisualization.tsx`.

2. **Benchmark de tokens** (tema separa
…[truncado]
```

**Variant B run#1:**

```
## Resposta

**Arquivo mais alterado:** `scripts/bench/cli-token-footprint.sh`, com **158 linhas** modificadas — o maior número de mudanças de qualquer arquivo no intervalo `HEAD~5..HEAD`.

Vale uma ressalva: se você considerar só **código de produção** (ignorando scripts de bench e os arquivos `results/*.md`, que são quase todos puramente adicionados), o líder é `src/utils/model/modelOptions.ts` com **111 linhas** (e foi um refactor real: 56 adições / 55 remoções, não só inserção).

## Os commits estão no mesmo tema?

**Não — são dois temas distintos** nos últimos 5 commits:

| Commit | Tema |
|--------|------|
| `2f87c82` chore(bench): cache-progression results | **Benchmark / tooling** |
| `94e613f` docs(prompts): nudge against piping Bash output | **Docs de prompt** (isolado) |
| `631f667` fix(model): annotate "(1M context)" | **Model / context picker** |
| `31128c9` feat(model): 200k + 1M context variants | **Model / context picker** |
| `bd8150d` style(context): tree spine in /co
…[truncado]
```

**Variant B run#2:**

```
## Resultado

**Arquivo mais alterado:** `scripts/bench/cli-token-footprint.sh`, com **158 linhas** de churn — é o maior número absoluto na coluna do `--stat`.

Vale a ressalva: esse é um script de benchmark. Se você quiser dizer "código de produção", o líder é `src/utils/model/modelOptions.ts` (**111 linhas**), seguido de perto por `src/components/ContextVisualization.tsx` (60). O total geral foi 19 arquivos, +1173/−119.

## Os 5 commits são do mesmo tema?

Não — são **dois temas distintos**, mais ruído de bench. Olhando o `git log`:

| Commit | Tema |
|--------|------|
| `2f87c82` chore(bench): cache-progression results | benchmark/dados |
| `94e613f` docs(prompts): nudge against piping to head/tail/cat | **avulso** (prompts) |
| `631f667` fix(model): annotate "(1M context)" | **modelo / picker de contexto** |
| `31128c9` feat(model): 200k + 1M context variants | **modelo / picker de contexto** |
| `bd8150d` style(context): tree spine in /context | UI de `/context` |

A espinha dorsa
…[truncado]
```

### tree-overview

> Liste recursivamente o conteudo de `src/services/api` com `ls -R src/services/api` e me diga, em uma frase, como esse diretorio esta organizado. Quero o panorama, nao a arvore inteira colada.

**Variant A run#1:**

```
O diretório agrupa o código por **provider/adaptador** — um núcleo de orquestração na raiz (`client.ts`, `activeProvider.ts`, `providerConfig.ts`, `withRetry.ts`, `errors.ts`) cercado de shims que traduzem o formato Anthropic para cada backend, sendo os maiores promovidos a subpastas próprias (`claude/`, `openaiShim/`, `codexShim.ts`, `minimaxUsage/`), com cada arquivo de implementação acompanhado do seu `*.test.ts` colocado ao lado.
```

**Variant A run#2:**

```
`src/services/api` é a camada de abstração de provider: um núcleo de arquivos no topo (`client.ts`/`clientCache.ts` para construir o SDK, `activeProvider.ts`/`providerConfig.ts` para seleção e credenciais, `withRetry.ts`/`errors*.ts` para retry/classificação de erro, e vários `*Usage`/`cache*` para métricas), com os adaptadores de cada formato isolados em subpastas — `claude/` (nativo Anthropic), `openaiShim/` (tradução para OpenAI-compatible) e `codex*`/`minimaxUsage/` — cada um acompanhado dos seus próprios testes colocalizados.
```

**Variant B run#1:**

```
O diretório é organizado por **provider/preocupação**: arquivos soltos na raiz cobrem a infraestrutura compartilhada (seleção de provider via `activeProvider.ts`/`providerConfig.ts`, construção de client em `client.ts`, retry/erros, cache de prompt, OAuth do Codex e usage de cada fornecedor), enquanto os adaptadores complexos ganham subpastas próprias (`claude/`, `openaiShim/`, `minimaxUsage/`) que decompõem o shim em conversão de mensagens, tools, streaming e headers — sempre com os `*.test.ts` colocados ao lado do código que cobrem.
```

**Variant B run#2:**

```
O diretório agrupa, na raiz, a lógica de cliente/provider compartilhada (`client.ts`, `activeProvider.ts`, `providerConfig.ts`, retry/erros/cache/usage) com cada provider colocado lado a lado seu `*.test.ts`, e isola os dois adapters mais pesados em subpastas próprias — `claude/` (formato Anthropic nativo) e `openaiShim/` (tradução para Chat Completions), além de `minimaxUsage/` para parsing de uso.
```

### deps-question

> Esse projeto usa zod? Rode `cat package.json` e me responda sim ou nao, dizendo qual versao se houver. Nao precisa despejar o arquivo todo.

**Variant A run#1:**

```
Sim. O projeto usa **zod**, versão **4.4.3**.
```

**Variant A run#2:**

```
Sim. Usa **zod**, versão **4.4.3** (dependência fixada em `package.json:111`).
```

**Variant B run#1:**

```
Sim. O projeto usa **zod**, na versão **4.4.3**.
```

**Variant B run#2:**

```
Sim. O projeto usa **zod**, versão **4.4.3**.
```

### env-then-config

> Rode `git config --list` e me diga qual e o user.email configurado. Depois rode `git remote -v` e confirme para onde o origin aponta. Respostas curtas e diretas.

**Variant A run#1:**

```
**user.email:** `andersonvieiraviudes@gmail.com`

**origin:** `ssh://git@git.house.server:2222/viudes/claudio.git` (fetch e push) — servidor Gitea self-hosted, não GitHub.
```

**Variant A run#2:**

```
**user.email:** `andersonvieiraviudes@gmail.com`

**origin:** `ssh://git@git.house.server:2222/viudes/claudio.git` (mesma URL para fetch e push) — servidor Git self-hosted via SSH na porta 2222.
```

**Variant B run#1:**

```
**user.email:** `andersonvieiraviudes@gmail.com`

**origin:** aponta para `ssh://git@git.house.server:2222/viudes/claudio.git` (servidor Gitea self-hosted, fetch e push iguais).
```

**Variant B run#2:**

```
**user.email:** `andersonvieiraviudes@gmail.com`

**origin:** `ssh://git@git.house.server:2222/viudes/claudio.git` (fetch e push) — servidor Gitea próprio.

Ambos batem com a config esperada (commit como viudes + remote Gitea).
```

