# Phase 9 — System utilities follow-ups: ping, rsync, tree, ssh, df, du, dmesg, jq, stat, curl-plain

> **Status:** ✅ Done — 2026-05-13
> **LoC estimado:** ~110 (sem RFC) + ~30 (curl-plain) = **~140 LoC**
> **PR:** _(preencher)_
> **Priority rationale:** maior ganho de tokens remanescente após Phase 8 — ping/rsync/tree são comandos comuns que despejam centenas de linhas sem filtro hoje. 4 sub-PRs (9a-9d) sem bloqueio de framework, cada um ~30 LOC e shippable independentemente.
> **Parent spec:** [`../architecture.md`](../architecture.md)
> **Discovery refs (leitura obrigatória antes de pegar):**
> - [`system-coverage-detail-2026-05.md`](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md) — gap analysis Claudin × RTK, FilterSpec proposta por comando, bloqueios de framework
> - [`system-utils-deep-dive-2026-05.md`](../../../discovery/bash-output-filter/system-utils-deep-dive-2026-05.md) — análise individual de cada comando com FilterSpec e ROI estimado
> - [`rtk-refinement-2026-05.md`](../../../discovery/bash-output-filter/rtk-refinement-2026-05.md) — visão das 6 famílias

Continuação da auditoria post-Phase 8: cobre os comandos de sistema (utilitários de FS, rede, processos) que o RTK trata mas o Claudin ainda não. Levantamento empírico em maio/2026 mostrou **8 gaps acionáveis sem bloqueio de framework** + **1 parcialmente cobertos** (curl) + **4 bloqueados por RFC**.

## Pré-requisitos

- [ ] Phase 1 — skeleton + harness
- [ ] Phase 3 — BashTool integration
- [ ] Phase 5 — built-in batch 2 (extends `system.ts` + `network.ts` já criados nessa fase)

Phase 9 **não cria arquivos novos** — extende `system.ts` (8 specs) e `network.ts` (1 spec).

## Filters incluídos (10 specs em 2 arquivos)

| Filter | Comando | Família | Estratégia | ROI esperado | LOC | Estudo |
|---|---|---|---|---|---|---|
| **ping** | `ping`, `ping6` | `system.ts` (EXTEND) | head 3 + tail 9 — preserva resolução DNS + `--- statistics ---` + `rtt min/avg/max` | ALTO | ~10 | [§3.4](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#34-ping--p1) |
| **rsync** | `rsync …` | `system.ts` (EXTEND) | strip linhas de arquivo individual + banner `sending incremental file list`, preserva `sent X / received Y / total size / speedup` | ALTO | ~14 | [§3.5](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#35-rsync--p1) |
| **tree** | `tree`, `tree -L N` | `system.ts` (EXTEND) | head 50 + tail 25, strip ANSI, reject `-J`/`-X` (formatos estruturados) | ALTO | ~12 | [§3.1](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#31-tree--p2) |
| **ssh** | `ssh host …` | `system.ts` (EXTEND) | strip `^debug\d+:` (verbosidade `-v`/`-vv`/`-vvv`) | MÉDIO | ~8 | [§3.6](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#36-ssh--p2) |
| **df** | `df`, `df -h` | `system.ts` (EXTEND) | strip `^(tmpfs|devtmpfs|squashfs|overlay|fuse\.)`, reject `-a`/`--all` | ALTO | ~14 | [§3.2](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#32-df--p1) |
| **du** | `du`, `du -h` | `system.ts` (EXTEND) | strip subpaths profundos em `node_modules/.*/node_modules/` e `.git/(refs\|objects)/`, head 30 + tail 30 | MÉDIO (sem sort) | ~12 | [§3.3](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#33-du--p1) |
| **dmesg** | `dmesg` | `system.ts` (EXTEND) | tail 60 (eventos mais recentes são mais relevantes) | MÉDIO | ~8 | [§3.8](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#38-dmesg--p3) |
| **stat** | `stat path` | `system.ts` (EXTEND) | `maxLines: 40` — output já curto, P3 | BAIXO | ~6 | [§3.7](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#37-stat--p3) |
| **jq** | `jq '…' [file]` | `system.ts` (EXTEND) | `maxLines: 100`; reject agressivo (`-r`/`--raw-output`/`-c`/`--compact-output`/`--tab`/`-j`) p/ preservar parseável | BAIXO | ~8 | [§3.9](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#39-jq--p2) |
| **curlPlain** | `curl URL` (sem `-v`/`-s`/`-I`/`-o`) | `network.ts` (EXTEND) | strip progress-bar header + linhas `Dload Upload` + linhas `\d+ \d+[kKMG]? \d+` | ALTO | ~12 | [§3.10](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#310-curl-extension--p1-parcial-pode-ir-já) |

**Subtotal:** ~104 LOC de specs novas (sem testes/fixtures). Phase 9 é a maior por contagem de specs, mas cada uma é pequena por ser declarativa pura.

## Sub-divisão em PRs (recomendado)

Phase 9 é grande para uma única PR — sugestão é quebrar em 4:

| PR | Specs | LOC | Justificativa |
|---|---|---|---|
| **9a** | `ping` + `rsync` + `tree` | ~36 | Maior ROI agregado. `rsync` regex frágil — validar fixtures antes de mergear. |
| **9b** | `ssh` + `df` + `stat` | ~28 | Baixo risco, complementa Phase 9a. |
| **9c** | `dmesg` + `du` (mínima, sem sort) + `jq` | ~28 | Tail decisions empíricas — validar amostra. |
| **9d** | `curlPlain` (progress bar stripping) | ~12 | Pode ir junto com 9a/9b se houver capacidade. |

Cada sub-PR é independente — pegar na ordem da tabela é o caminho de menor risco.

## Bloqueado — não está nesta fase

Estes itens **requerem RFC de framework** antes (`FilterSpec` não tem capability hoje). Documentados em [`system-coverage-detail-2026-05.md` §4.2–4.3](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#42-prs-bloqueados-por-rfc-de-framework):

| Item | Bloqueio | RFC necessário |
|---|---|---|
| `curl-body` (truncation a 500 B + JSON-aware passthrough) | sem `maxBytes` UTF-8-safe nem `matchOutput.passthroughIf` | `maxBytes`, `passthroughIf` |
| `du` com sort por tamanho (top-N maiores) | sem `postProcess`/`sortBy` | `sortBy` |
| `ping`/`rsync` skip-filter em exit ≠ 0 por spec | só existe flag global `isError` | `preserveOnError` |
| `tee_and_hint` para recuperação de output truncado | feature totalmente nova | storage + hook |

Após Phase 9, abrir RFC separado para essas 4 capabilities — habilitam Phase 10 (curl-body completo, du-sort, robustez de erro).

## Skip deliberado — não fazer

| Comando | Razão |
|---|---|
| `find` | RTK mediu ROI 0% — output é nome de arquivo, sem ruído estrutural |
| `wc`, `cat`, `head`, `tail` | Conteúdo é dado, não ruído. Filtrar destrói informação. RTK também não tem. |
| `env` | Output é dado (variáveis). Filtrar tokens não ajuda; risco de leak. Issue separada de **secret masking** (camada diferente). |
| `top` (interativo) | TUI — não chega ao filter via captura. Caso `top -b -n 1` já coberto em Phase 5. |

Justificativa completa: [§5 do system-coverage-detail](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#5-decisões-de-não-implementar-skip-deliberado).

## O que muda no codebase

### Arquivos modificados (sem novos)

| Arquivo | Mudança |
|---|---|
| `src/outputFilter/Bash/filters/system.ts` | + 9 specs (`ping`, `rsync`, `tree`, `ssh`, `df`, `du`, `dmesg`, `stat`, `jq`) + ~25 const regex no topo |
| `src/outputFilter/Bash/filters/network.ts` | + 1 spec (`curlPlain`) + 3 const regex (`CURL_ANY`, `CURL_BODY_REJECT`, `CURL_PROGRESS_*`) |
| `src/outputFilter/Bash/filters/index.ts` | + 10 entradas no `builtInFilters` |
| `src/outputFilter/Bash/bashFilter.test.ts` | + 10 `describe('phase 9 — <filter>')` blocks |
| `src/outputFilter/Bash/__fixtures__/samples/*` | + ~10 fixtures realistas (uma por spec) |
| `docs/discovery/bash-output-filter/validation/samples/*` | mirror das fixtures (harness lê desse path) |
| `scripts/profile/bash-filter-gain.test.ts` | + 10 entradas no `SCENARIOS` array |

### Fixtures necessárias

Coletar amostra real para cada (não inventar):

- `ping-google.txt` — `ping -c 20 google.com`
- `rsync-incremental.txt` — `rsync -av src/ dst/` em diretório com ~100 arquivos
- `tree-deep.txt` — `tree` em repo com ≥ 200 arquivos
- `ssh-vvv.txt` — `ssh -vvv host echo ok`
- `df-h.txt` — `df -h` em sistema com ≥ 5 tmpfs
- `du-h.txt` — `du -h node_modules/` em projeto JS
- `dmesg-tail.txt` — `dmesg | tail -200`
- `stat-file.txt` — `stat package.json`
- `jq-pretty.txt` — `curl … | jq '.'` em JSON ~50 linhas
- `curl-progress.txt` — `curl -o /tmp/out https://…` (sem `-v`/`-s`)

## Cuidados específicos (do estudo)

1. **`ping`** — NUNCA strippar a linha `--- statistics ---` nem `rtt min/avg/max` (são o ponto do comando). Head 3 + tail 9 cobre.

2. **`rsync`** — regex `RSYNC_FILE_LINE` é frágil e pode capturar mensagens de erro. Usar `keepLinesMatching` para palavras-chave (`rsync:`, `error`, `IO error`, `sent`, `received`, `total size`, `speedup`) **antes** do strip, OU inverter a estratégia para keep-list em vez de strip-list. Validar com fixture real de erro.

3. **`tree`** — `matchCommandReject: /-J\b|--json\b|-X\b|--xml\b/` é crítico — strip em saída JSON quebra parsers downstream.

4. **`du`** — versão mínima sem sort. Quando RFC `sortBy` landed, atualizar para ordenar por tamanho e manter top-N. Hoje só strip de subdirs conhecidos profundos.

5. **`jq`** — `matchCommandReject` agressivo é o ponto: se o usuário pediu `-r` ou `-c`, é consumo programático downstream — passthrough completo, sem filtrar. Sem `maxBytes` UTF-8-safe não dá para truncar bytes; só `maxLines`.

6. **`curlPlain`** — não casar com `curl -v` (vai pro `curlV` existente da Phase 5/network), nem com `-s`/`--silent` (já sem progress bar), nem com `-I`/`--head`/`-o`/`--output` (sem body relevante para o agente). Só strip do progress bar.

7. **`dmesg`** — decisão head vs tail é empírica. Validar com amostra: se `dmesg` típico do usuário tem informação relevante no início, mudar para head. Default aqui é tail (eventos recentes).

8. **`df`** — preservar tmpfs quando `-a`/`--all` está presente (intenção explícita do usuário de ver tudo).

9. **`ssh`** — só ajuda em `ssh host 'command'` ou scripts. SSH interativo geralmente não passa pelo filter (TTY). ROI moderado mas robusto.

10. **`stat`** — P3, output já curto. Pode ser adiado para Phase 9c ou indefinidamente. Incluir apenas se houver capacidade.

## Specs concretos (copy-paste pronto)

### system.ts — extensão

```ts
// ===== ping =====
const PING = /^ping6?\b/

export const ping: FilterSpec = {
  name: 'ping',
  matchCommand: PING,
  maxLines: 12,
  headLines: 3,
  tailLines: 9,
}

// ===== rsync =====
const RSYNC = /^rsync\b/
const RSYNC_FILE_LINE = /^[a-zA-Z0-9_.\-/][\w.\-/]+(?:\.[a-zA-Z0-9]+)?$/
const RSYNC_BANNER = /^(?:sending|receiving) incremental file list$/

export const rsync: FilterSpec = {
  name: 'rsync',
  matchCommand: RSYNC,
  stripLinesMatching: [RSYNC_FILE_LINE, RSYNC_BANNER],
  maxLines: 30,
  headLines: 5,
  tailLines: 25,
}

// ===== tree =====
const TREE = /^tree\b/
const TREE_REJECT = /-J\b|--json\b|-X\b|--xml\b/

export const tree: FilterSpec = {
  name: 'tree',
  matchCommand: TREE,
  matchCommandReject: TREE_REJECT,
  stripAnsi: true,
  maxLines: 80,
  headLines: 50,
  tailLines: 25,
}

// ===== ssh =====
const SSH = /^ssh\b/
const SSH_DEBUG = /^debug\d+:\s/

export const ssh: FilterSpec = {
  name: 'ssh',
  matchCommand: SSH,
  stripLinesMatching: [SSH_DEBUG],
  maxLines: 50,
}

// ===== df =====
const DF = /^df\b/
const DF_REJECT = /-a\b|--all\b/
const DF_NOISE = /^(?:tmpfs|devtmpfs|squashfs|overlay|fuse\.|none\s)/

export const df: FilterSpec = {
  name: 'df',
  matchCommand: DF,
  matchCommandReject: DF_REJECT,
  stripLinesMatching: [DF_NOISE],
  maxLines: 40,
}

// ===== du =====
const DU = /^du\b/
const DU_DEEP_NOISE = /\.git\/(?:refs|objects)\/|node_modules\/.+\/node_modules\//

export const du: FilterSpec = {
  name: 'du',
  matchCommand: DU,
  stripLinesMatching: [DU_DEEP_NOISE],
  maxLines: 60,
  headLines: 30,
  tailLines: 30,
}

// ===== dmesg =====
const DMESG = /^dmesg\b/

export const dmesg: FilterSpec = {
  name: 'dmesg',
  matchCommand: DMESG,
  maxLines: 60,
  headLines: 0,
  tailLines: 60,
}

// ===== stat =====
const STAT = /^stat\b/

export const stat: FilterSpec = {
  name: 'stat',
  matchCommand: STAT,
  maxLines: 40,
}

// ===== jq =====
const JQ = /^jq\b/
const JQ_STRUCTURED = /-r\b|--raw-output\b|-c\b|--compact-output\b|--tab\b|-j\b|--join-output\b/

export const jq: FilterSpec = {
  name: 'jq',
  matchCommand: JQ,
  matchCommandReject: JQ_STRUCTURED,
  maxLines: 100,
}
```

### network.ts — extensão

```ts
// ===== curl (sem -v) — strip de progress bar =====
const CURL_ANY = /^curl\b/
const CURL_BODY_REJECT = /(?:^|\s)(?:-v\b|--verbose\b|-s\b|--silent\b|-I\b|--head\b|-o\s|--output\s)/

const CURL_PROGRESS_HEADER = /^\s*%\s+Total\s+%\s+Received/
const CURL_PROGRESS_RULE = /^\s*Dload\s+Upload/
const CURL_PROGRESS_DATA = /^\s*\d+\s+\d+[kKMG]?\s+\d+\s+\d+[kKMG]?/

export const curlPlain: FilterSpec = {
  name: 'curl-plain',
  matchCommand: CURL_ANY,
  matchCommandReject: CURL_BODY_REJECT,
  stripAnsi: true,
  stripLinesMatching: [CURL_PROGRESS_HEADER, CURL_PROGRESS_RULE, CURL_PROGRESS_DATA],
}
```

## Tests

```bash
bun test src/outputFilter/Bash/bashFilter.test.ts          # +10 describe blocks
bun test src/outputFilter/Bash                              # full suite — verificar zero regressões
CLAUDIN_BENCH=1 bun test scripts/profile/bash-filter-gain.test.ts   # gain table — +10 linhas
bun run typecheck
```

Cada `describe('phase 9 — <filter>')` cobre (template de [§6 do system-coverage-detail](../../../discovery/bash-output-filter/system-coverage-detail-2026-05.md#6-onde-colocar-o-código-módulo-a-módulo)):

- **ROI** — `assertReduction` com target da tabela acima
- **match positivo** — comando happy path
- **reject** — flag que deve dar passthrough (`-J` para tree, `-a` para df, `-r` para jq, etc.)
- **preserves** — linha crítica que NÃO pode ser strippada:
  - `ping`: `--- statistics ---` + `rtt min/avg/max`
  - `rsync`: `sent X received Y`, `total size`, `speedup`
  - `df`: linha header `Filesystem ... Mounted on`
  - `jq`: estrutura JSON preservada se não casar reject
  - `curlPlain`: nenhuma linha do body real strippada

## Acceptance criteria

- [ ] 10 specs implementados com fixture realista
- [ ] Cada spec passa `assertReduction` ≥ ROI esperado da tabela − 5pp tolerância
- [ ] `ping`: stats e rtt sempre preservados (assert positivo)
- [ ] `rsync`: summary lines preservadas; teste com fixture de erro (`rsync: failed: …`) não strippa erro
- [ ] `df`: header line + linhas com paths reais preservadas; `df -a` passa cru
- [ ] `tree -J` / `tree -X`: passa cru, JSON/XML não corrompido
- [ ] `jq -r`/`-c`/`-j`: passa cru
- [ ] `curlPlain`: `curl -v` continua indo pelo `curlV` (não duplica filter)
- [ ] `regex-redos-scan.test.ts` passa
- [ ] Bench atualizado com +10 entradas
- [ ] Zero regressões em specs anteriores
- [ ] Privacy check: `bun run verify:privacy` continua passando

## PR description template

```markdown
## feat(bash-filter): system utilities — ping/rsync/tree/ssh/df/du/dmesg/stat/jq + curl-plain (Phase 9)

Adds 10 declarative FilterSpecs covering system utilities (filesystem, network, process)
that RTK covers but Claudin did not. Auditoria de gaps em maio/2026
(docs/discovery/bash-output-filter/system-coverage-detail-2026-05.md).

### Filters added
- **ping** (ALTO ROI): head 3 + tail 9, preserva `--- statistics ---` + rtt
- **rsync** (ALTO): strip arquivos individuais, preserva summary
- **tree** (ALTO): head/tail; reject `-J`/`-X`
- **ssh** (MÉDIO): strip `debug\d+:` lines
- **df** (ALTO): strip tmpfs/devtmpfs/squashfs; reject `-a`
- **du** (MÉDIO sem sort): strip subdirs profundos node_modules/.git/refs
- **dmesg** (MÉDIO): tail 60 (eventos recentes)
- **stat** (BAIXO): maxLines 40
- **jq** (BAIXO): reject `-r`/`-c`/`-j` para preservar consumo programático
- **curl-plain** (ALTO): strip progress-bar header + data lines (curl URL sem -v/-s)

### Notable details
- `ping`/`rsync`: linhas de erro/summary explicitamente preservadas (validado em fixtures)
- `jq`: sem `maxBytes` UTF-8-safe, só `maxLines` — single-line gigante passa cru
- `curlPlain` complementa `curlV` (Phase 5) — não duplica filter

### Bloqueado para Phase 10 (RFC framework)
- `curl-body` (truncation + JSON passthrough) — precisa `maxBytes` + `passthroughIf`
- `du` com sort — precisa `sortBy`
- `skip-on-error` por spec — precisa exposição de `exitCode`

### Tests
- 10 new `describe('phase 9 — <filter>')` blocks
- All assertReduction targets met
- Safety guards: ping stats, rsync summary, df header, jq structured-output reject

### Refs
- Phase doc: docs/tech/bash-output-filter/phases/phase-9-system-utils.md
- Discovery: docs/discovery/bash-output-filter/system-coverage-detail-2026-05.md
- Roadmap: 6.3 (Active)
```

## Implementation notes

Shipped 2026-05-13 in a single PR (não usou sub-PRs 9a–9d — escopo manejável). Desvios da spec original:

- **`tree`**: anchor da `matchCommand` mudada para `/^tree(?=\s|$)/` em vez de `/^tree\b/` para evitar colisão com `tree-sitter` (binário comum em dev toolchains TS/Rust). Test `tree-sitter is not claimed` documenta isso.
- **`ssh`**: idem — anchor `(?=\s|$)` evita falsos-positivos com `ssh-add`, `ssh-keygen`, `ssh-copy-id` (sem isso, `/^ssh\b/` casava todos).
- **`rsync` `RSYNC_FILE_LINE`**: anchor `^[\w.][\w./-]*$` (alnum/`./-` apenas, sem espaços) em vez do regex original do spec — garante que linhas de erro (`rsync: failed ...`, contêm `:` e espaços) ou summary (`sent X bytes`, contém espaços) **nunca** casem como filename. Validado em test `error lines are preserved`.
- **`curlPlain`**: estratégia revisada — em vez de só stripar três regex de progress, faço primeiro `replace` de `[^\r\n]*\r` para colapsar overwrites de carriage-return (que é como `curl` realmente desenha o medidor; em buffer capturado essas linhas se acumulam). Sem isso, ROI medido ficava em ~30% (linhas de dados não casavam dos regex declarativos porque sobreviviam ao `\r`). Com o colapso, ROI medido subiu para 78.4% (target era 40%).
- **`stat` / `jq`**: ROI fixture-dependente — fixture típica é curta (<40 linhas para stat, <100 para jq), então a cap nunca dispara. Mantidos no harness para defesa-em-profundidade (`stat -L` em symlink chain, `jq '.'` em JSON grande). Sem `predicted%` no gain bench — só safety tests.
- **`du`**: `DU_DEEP_NOISE` ajustado para `(?:^|\/)\.git\/(?:refs|objects)\/|node_modules\/[^/]+\/node_modules\/`. Comparado ao spec original (`\.git\/(?:refs|objects)\/`), o `(?:^|\/)` ancora à raiz do path para não casar nomes de arquivos contendo a sub-string `.git/refs/`. Não houve fixture com essa colisão, mas é defesa preventiva.
- **Test ajustado em `curlV`**: o test "no match: curl https://example.com (no -v, should passthrough)" tinha como invariante que comando `curl` sem flag não tinha filtro. Phase 9 quebra essa invariante de propósito (curl-plain agora cobre exatamente esse caso). Test atualizado para verificar que `curl <URL>` retorna `curl-plain` e `curl -v <URL>` continua indo pro `curlV`.

Gain table (CLAUDIN_BENCH=1, fixtures reais):

| Filter | RAW | OUT | RED% | PRED% |
|---|---|---|---|---|
| ping | 1.3K | 546B | 58.1% | 55% ✓ |
| rsync | 1.1K | 96B | 91.1% | 70% ✓ |
| tree | 2.9K | 1.4K | 51.9% | 30% ✓ |
| ssh | 2.0K | 44B | 97.9% | 70% ✓ |
| df | 881B | 353B | 59.9% | 40% ✓ |
| du | 966B | 392B | 59.4% | — |
| dmesg | 4.7K | 3.4K | 26.7% | 25% ✓ |
| stat | 409B | 409B | 0.0% | — (fixture under cap) |
| jq | 332B | 332B | 0.0% | — (fixture under cap) |
| curl-plain | 501B | 108B | 78.4% | 40% ✓ |

Aggregate gain (41 filters, including Phase 9): **69.9%** reduction across 200.6K → 60.3K of fixture bytes.

RFC pendente para Phase 10 (não-bloqueante para 9): `maxBytes` UTF-8-safe (`curl-body`), `sortBy` (`du` top-N), `preserveOnError` por spec, `tee_and_hint` para recuperação de truncamento.

### Post-ship audit (2026-05-13)

Auditoria independente após o ship apontou 3 perdas de sinal críticas. Corrigidas no mesmo dia, com testes de regressão:

- **A1 — `jq`**: `maxLines:100` cortava JSON pretty no meio, produzindo JSON inválido. **Fix:** removido o cap — JSON estruturado nunca deve ser head/tail-cortado. Truncamento de saídas muito grandes fica a cargo do tail-cap global da ferramenta. Test: `large pretty-printed JSON is not truncated (A1 regression)` valida com `JSON.parse(body)`.
- **A3 — `df`**: `overlay` estava na lista de strip, escondendo o sinal de disk-usage do Docker (`/var/lib/docker/overlay2/...`). **Fix:** `overlay` removido do `DF_NOISE`. ROI cai de 59.9% para ~44%, mas preserva o caso de uso real. Test: `overlay rows are preserved (docker disk-usage signal)`.
- **A4 — `dmesg`**: `headLines:0, tailLines:60` descartava boot-time (BIOS/PCI/ACPI/USB enumeration) — o motivo #1 para alguém rodar `dmesg`. **Fix:** `headLines:10, tailLines:50`. Mantém ROI ~24% (dentro da tolerância de ±5pp do target de 25%). Test: `boot-time lines are kept (head=10) — A4 regression`.

Achados não-críticos (A2 `tree`, A5 `ping`) ficam tracked para Phase 10 — não são blockers porque `tree` preserva o summary `N directories, M files` e `ping` preserva o bloco de statistics, dando ao modelo sinal agregado de "algo aconteceu" mesmo quando linhas intermediárias somem.

### Corner-case audit (2026-05-13, second pass)

Auditoria adversarial de corner cases identificou hardening adicional. Aplicado P0 + P1 no mesmo dia:

- **P0 C1 — `jq` revisitado**: o fix A1 removeu *todos* os caps, deixando `jq` ilimitado. Um output de 50k linhas iria estourar contexto ou ser cortado pelo cap global (também produzindo JSON inválido, só que de forma menos óbvia). **Fix:** introduzido `maxLines:500, headLines:200, tailLines:300` como meio-termo. Outputs até ~500 linhas (≈30 KB) passam intactos; acima disso, o omit marker explícito (`…N lines omitted…`) sinaliza ao LLM que o JSON foi truncado e ele pode pedir um filtro `jq` mais restrito. Test: `huge JSON over 500 lines is bounded with omit marker (P0 C1)`.
- **P0 — `truncateLineAt: 4096` em `ping`, `tree`, `dmesg`**: defesa contra linhas pathológicamente longas (`ping -f` colapsado, `tree` de diretório flat com 50k entries, dump de stack kernel de 16 KB em uma linha). Sem isso, uma única linha podia consumir todo o budget. Tests: `defense: pathologically long lines are truncated` em cada filtro.
- **P0 — `stripAnsi: true` em `dmesg`**: `dmesg --color=always` injeta CSI codes mesmo em saída não-TTY. Sem strip, eles inflam o budget e podem confundir o LLM. Test: `ANSI color codes from --color=always are stripped`.
- **P1 — `rsync --info=progress2` CR-collapse**: o single-line progress meter do rsync `\r`-overwrites a si mesmo, idêntico ao do curl. **Fix:** adicionada a mesma pass de CR-overwrite (`[^\r\n]*\r` → `''`) que `curl-plain` já usava. ReDoS-safe (linear, char class sem backtrack). Test: `--info=progress2 CR-overwrites collapse`.

5 testes de regressão novos, todos verdes (615/615 outputFilter pass). Sem regressão de ROI nos fixtures existentes.
