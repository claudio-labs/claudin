# System Utils — Cobertura Detalhada Claudin × RTK (2026-05)

Documento de refinamento para o roadmap de filtros de comandos de sistema. Comparação comando-a-comando entre o que o **Claudin** (`src/outputFilter/Bash/filters/`) já implementa e o que o **RTK** (`rtk/src/cmds/system/` + `rtk/src/filters/*.toml`) cobre. Cada seção tem detalhes suficientes para um implementador pegar e executar sem precisar re-explorar os dois repos.

Documentos relacionados:
- [`system-utils-deep-dive-2026-05.md`](./system-utils-deep-dive-2026-05.md) — análise de cada comando isoladamente com FilterSpec proposta
- [`rtk-refinement-2026-05.md`](./rtk-refinement-2026-05.md) — visão das 6 famílias

---

## 0. Limites estruturais do framework Claudin

Levantamento confirmado pelo agente em `src/outputFilter/Bash/types.ts` (34 LOC) e `pipeline.ts` (587 LOC):

**Knobs disponíveis no `FilterSpec`:**

```
name, matchCommand, matchCommandReject, rewriteCommand,
stripAnsi, replace, collapseRuns, collapseDigitTemplates, dedupGlobal,
matchOutput, stripLinesMatching, keepLinesMatching,
truncateLineAt, headLines, tailLines, maxLines, onEmpty
```

**Não existe:**
- `postProcess` / `transform` / `maxBytes`
- Acesso a `exitCode`, `stderr` separado, ou flag por stream
- `skip_filter_on_failure` por spec (existe apenas a flag global `isError` no `applyBashFilterToStdout`, que dá passthrough total)
- `tee_and_hint` para recuperação de output truncado
- `match_output` com `unless` (existe `matchOutput` mas sem cláusula `unless` confirmada — verificar antes de assumir)

**RTK tem todos esses recursos.** Várias decisões de arquitetura abaixo encostam nessa diferença e geram **bloqueios de framework** sinalizados explicitamente em cada seção.

---

## 1. Resumo executivo

| Comando | Claudin | RTK | Gap | Prioridade |
|---|---|---|---|---|
| `ls` | ✅ `lsLa` | ✅ `ls.rs` (runner) | menor (RTK estima width terminal) | — |
| `grep` / `rg` | ✅ `grepRg` | ✅ `grep_cmd.rs` (runner) | RTK injeta `--color=never`, deduplica path | baixo |
| `ps aux` | ✅ `psAux` | ✅ TOML `ps.toml` | similares | baixo |
| `top` | ✅ `top` (batch) | ❌ sem filtro RTK | Claudin à frente | — |
| `journalctl` | ✅ `journalctl` | ❌ sem filtro RTK | Claudin à frente | — |
| `curl` | ⚠ `curlV` apenas (modo `-v`) | ⚠ runner externo ao `system/` | ALTO — falta progress bar, body trunc | **P1** |
| `dig` | ✅ `dig` | ❌ sem filtro RTK | Claudin à frente | — |
| `find` | ❌ | ✅ `find_cmd.rs` (runner) | medido ROI 0% no RTK | **SKIP** |
| `tree` | ❌ | ✅ `tree.rs` (runner) | médio | **P2** |
| `df` | ❌ | ✅ TOML `df.toml` | alto | **P1** |
| `du` | ❌ | ✅ TOML `du.toml` | alto | **P1** |
| `stat` | ❌ | ✅ TOML `stat.toml` | baixo (uso esporádico) | P3 |
| `ping` | ❌ | ✅ TOML `ping.toml` | alto (output muito ruidoso) | **P1** |
| `rsync` | ❌ | ✅ TOML `rsync.toml` | alto | **P1** |
| `ssh` | ❌ | ✅ TOML `ssh.toml` | médio | P2 |
| `dmesg` | ❌ | ❌ | médio | P3 |
| `jq` | ❌ | ✅ `json_cmd.rs` (runner com UTF-8 safety) | médio (precisa passthrough JSON) | P2 |
| `wc` | ❌ | ✅ `wc_cmd.rs` (runner) | baixo (output já é compacto) | **SKIP** |
| `cat`/`head`/`tail` | ❌ | ❌ (folded em `read.rs`) | baixo | **SKIP** |
| `env` | ❌ | ✅ `env_cmd.rs` (runner) | baixo + privacy concern | **SKIP** |

**Já cobertos com qualidade boa: 7** (ls, grep/rg, psAux, top, journalctl, curlV-parcial, dig)
**Gaps acionáveis: 8** (curl-extend, tree, df, du, ping, rsync, ssh, jq)
**Skip deliberado: 5** (find, wc, cat/head/tail, env, stat=opcional)

---

## 2. Comandos JÁ cobertos — detalhe e gap residual

### 2.1 `ls -la` — `src/outputFilter/Bash/filters/ls.ts` (37 LOC)

**Claudin:**
- `matchCommand`: `/^ls\b/`
- `matchCommandReject`: `/-1\b|--format=single/`
- Estratégia: `replace` que colapsa linhas detalhadas em formato curto, mantendo permissões + nome
- Sem `maxLines` explícito (depende do tamanho natural)

**RTK (`ls.rs`):** runner completo. Calcula largura do terminal, formata em colunas, omite metadados quando exit != 0 (`skip_filter_on_failure`).

**Gap residual:** Claudin não tem awareness de TTY (sempre captura). RTK consegue degradar para listagem simples em pipe. Para nós, isso é não-aplicável — sempre estamos em modo capture.

**Verdict:** ✅ paridade funcional. Sem ação.

---

### 2.2 `grep` / `rg` — `src/outputFilter/Bash/filters/grep-rg.ts` (36 LOC)

**Claudin:**
- `matchCommand`: `/^(?:grep|rg)\b/`
- Estratégia: `replace` que encurta paths longos
- Sem stripping de matches

**RTK (`grep_cmd.rs`):** runner Rust. Injeta `--color=never`, normaliza paths, opera em `Vec<char>` para UTF-8 safety, deduplica linhas idênticas com counter.

**Gap residual menor:**
- Claudin não força `--color=never` → se o usuário rodar `grep --color=always foo file`, ANSI vai vazar. (Mitigável adicionando `stripAnsi: true` na spec.)
- Sem dedup por linha.

**Verdict:** ✅ ok. Melhoria possível: adicionar `stripAnsi: true` e `dedupGlobal: true` opcional. **~3 LOC, P3.**

---

### 2.3 `ps aux` — `src/outputFilter/Bash/filters/system.ts` (compartilhado, 69 LOC)

**Claudin:**
- Strip de kernel threads (linhas com `[kthreadd]`, `[ksoftirqd/N]`, etc.)
- `maxLines: 50`

**RTK (`ps.toml`):** schema TOML similar. Stripping de kthreads via regex.

**Verdict:** ✅ paridade. Sem ação.

---

### 2.4 `top` — `src/outputFilter/Bash/filters/system.ts`

**Claudin:**
- Strip de kthreads
- `maxLines: 60`

**RTK:** ❌ nenhum filtro. Provavelmente intencional (top é TUI; comando one-shot é `top -b -n 1`).

**Verdict:** ✅ Claudin à frente. Sem ação.

---

### 2.5 `journalctl` — `src/outputFilter/Bash/filters/system.ts`

**Claudin:**
- `replace` que normaliza hostname para `<host>`
- `stripLinesMatching` para banners e separadores

**RTK:** ❌ nenhum filtro de `journalctl` (apenas `systemctl status`).

**Verdict:** ✅ Claudin à frente. Sem ação.

---

### 2.6 `curl -v` — `src/outputFilter/Bash/filters/network.ts` (77 LOC compartilhado)

**Claudin:**
- `matchCommand`: `/^curl\b.*(?:-v|--verbose)\b/`
- `stripAnsi: true`
- 9 regexes de `stripLinesMatching` cobrindo TLS/SSL/IPv/ALPN/CAfile/Trying/Connection/handshake
- `maxLines: 100`

**RTK:** o `curl` está em `RUST_HANDLED_COMMANDS` mas o handler real fica em `src/cmds/cloud/curl_cmd.rs` (fora do escopo deste doc). Ele:
- Injeta `-s` automaticamente → progress bar nunca aparece
- Detecta JSON via regex `^[{["]` e faz passthrough
- Trunca body não-JSON a 500 bytes com `is_char_boundary`
- `tee_and_hint` em failure para recuperação

**Gap ALTO:** `curl URL` sem `-v` (mais comum) **não casa** com `curlV`. Progress bar vaza inteira.

**Verdict:** ⚠ cobertura parcial — ver **P1.curl-extend** na seção 4.

---

### 2.7 `dig` — `src/outputFilter/Bash/filters/network.ts`

**Claudin:**
- `stripAnsi: true`
- 2 regex de strip: `;;` (linhas de comentário duplo) e `;\s` (banners/EDNS)
- `maxLines: 50`
- Cuidado para não bater na linha QUESTION (`;name. IN A`)

**RTK:** ❌ nenhum filtro.

**Verdict:** ✅ Claudin à frente. Sem ação.

---

## 3. Comandos FALTANDO — detalhe completo por gap

Para cada um: o que RTK faz, o que precisaria no Claudin, FilterSpec proposta, bloqueios.

### 3.1 `tree` — P2

**RTK (`src/cmds/system/tree.rs`):** runner. Strip ANSI, limita profundidade implicitamente via `max_lines`, preserva primeira linha (root) e estrutura. Listas longas têm head/tail.

**Output bruto típico:**
```
project
├── src
│   ├── components
│   │   ├── Button.tsx
│   │   ├── ...
```

**FilterSpec proposta:**
```ts
// system.ts — adicionar
const TREE = /^tree\b/
const TREE_REJECT = /-J\b|--json\b|-X\b|--xml\b/  // não filtrar formatos estruturados

export const tree: FilterSpec = {
  name: 'tree',
  matchCommand: TREE,
  matchCommandReject: TREE_REJECT,
  stripAnsi: true,
  maxLines: 80,
  headLines: 50,
  tailLines: 25,
}
```

**LOC estimado:** ~12. **ROI esperado:** ALTO — `tree` em repo grande tipicamente gera milhares de linhas.

**Bloqueios:** nenhum.

**Cuidado de teste:** garantir que `tree -L 1` (já curto) passa sem alteração. Garantir que `tree -J` (JSON) vai pelo reject.

---

### 3.2 `df` — P1

**RTK (`df.toml`):** TOML curto. Strip de filesystems irrelevantes (tmpfs/devtmpfs/squashfs), preserva linha de header e linhas com paths reais.

**Output bruto típico (`df -h`):**
```
Filesystem      Size  Used Avail Use% Mounted on
dev             7.8G     0  7.8G   0% /dev
run             7.9G  1.4M  7.9G   1% /run
/dev/nvme0n1p2  450G  220G  208G  52% /
tmpfs           7.9G  100M  7.8G   2% /dev/shm
tmpfs           7.9G  3.2M  7.9G   1% /tmp
...
```

**FilterSpec proposta:**
```ts
const DF = /^df\b/
const DF_NOISE = /^(?:tmpfs|devtmpfs|squashfs|overlay|fuse\.|none\s)/
const DF_HEADER = /^Filesystem\b/

export const df: FilterSpec = {
  name: 'df',
  matchCommand: DF,
  stripLinesMatching: [DF_NOISE],
  keepLinesMatching: undefined,  // strip wins se ambos definidos? confirmar pipeline order
  maxLines: 40,
}
```

**Cuidado:** se o usuário precisa de tmpfs (ex: investigando RAM), o strip atrapalha. Considerar `matchCommandReject: /-a\b|--all\b/` para preservar tudo quando `-a` está presente.

**LOC estimado:** ~14. **ROI esperado:** ALTO em containers/CI onde dezenas de tmpfs aparecem.

**Bloqueios:** nenhum.

---

### 3.3 `du` — P1

**RTK (`du.toml`):** strip de subdiretórios pequenos, mantém top-N maiores.

**Output bruto típico (`du -sh *` ou `du -h`):**
```
4.0K    ./.git/hooks
12K     ./.git/refs
1.2M    ./src/components
220M    ./node_modules
...
```

**Desafio:** o usuário quase sempre quer "qual é o maior". Strip simples por tamanho é arriscado (heurística pode esconder o que ele procura).

**Estratégia recomendada:**
- Detectar se já tem `-s` (summary) → passthrough
- Senão, ordenar por tamanho e manter top 30
- Mas isso requer reordenação, que o framework atual **não suporta** (só strip/keep/truncate)

**Bloqueio de framework:** sem `postProcess`, não dá pra fazer sort. Alternativas:
1. Implementar somente strip de paths `node_modules/.*/.*` e `.git/refs/.*` (sub-diretórios profundos de paths conhecidos como volumosos)
2. `maxLines: 60` com head/tail
3. Adicionar capability `sortBy` no framework (RFC separado)

**FilterSpec mínima (sem sort):**
```ts
const DU = /^du\b/
const DU_DEEP_NOISE = /\.git\/(refs|objects)\/|node_modules\/.+\/node_modules\//

export const du: FilterSpec = {
  name: 'du',
  matchCommand: DU,
  stripLinesMatching: [DU_DEEP_NOISE],
  maxLines: 60,
  headLines: 30,
  tailLines: 30,
}
```

**LOC estimado:** ~12 (mínima) / ~40 (com sort, requer RFC).

**ROI esperado:** MÉDIO mínima / ALTO com sort.

---

### 3.4 `ping` — P1

**RTK (`ping.toml`):** estratégia clássica head/tail — mantém primeiras 3 linhas (resolução DNS, primeiro PING) e últimas 5 (estatísticas finais, rtt min/avg/max).

**Output bruto típico:**
```
PING google.com (142.250.78.78) 56(84) bytes of data.
64 bytes from gru14s44-in-f14.1e100.net (142.250.78.78): icmp_seq=1 ttl=118 time=8.32 ms
64 bytes from ...
...
[N replies repetidos]
--- google.com ping statistics ---
N packets transmitted, N received, 0% packet loss, time Nms
rtt min/avg/max/mdev = 7.521/8.143/9.012/0.412 ms
```

**FilterSpec proposta:**
```ts
const PING = /^ping6?\b/

export const ping: FilterSpec = {
  name: 'ping',
  matchCommand: PING,
  maxLines: 12,
  headLines: 3,
  tailLines: 9,
}
```

**LOC estimado:** ~10. **ROI esperado:** ALTO — ping com `-c 100` ou sem `-c` (até Ctrl-C) gera ruído quase puro.

**Cuidado:**
- **Nunca engolir a linha `--- statistics ---`** nem `rtt min/avg/max` — são o ponto do comando.
- O framework garante head+tail = manter as primeiras 3 e últimas 9. Verificar que o omit-marker (`... N omitted ...`) não confunde parsers.

**Bloqueios:** nenhum.

---

### 3.5 `rsync` — P1

**RTK (`rsync.toml`):** strip de linhas de transferência individuais (`sending incremental file list` + cada arquivo), mantém summary final (`sent X bytes received Y bytes`).

**Output bruto típico (`rsync -av src/ dst/`):**
```
sending incremental file list
file1.txt
subdir/file2.txt
subdir/file3.txt
[milhares de linhas]
sent 1,234,567 bytes  received 89 bytes  246,931.20 bytes/sec
total size is 12,345,678  speedup is 10.00
```

**FilterSpec proposta:**
```ts
const RSYNC = /^rsync\b/
// strip individual file paths (linhas sem timestamp, prefixo, etc.)
const RSYNC_FILE_LINE = /^[^\s/][^\s]*\/.+$|^[a-zA-Z0-9_.\-]+\.[a-zA-Z0-9]+$/
const RSYNC_BANNER = /^sending incremental file list$|^receiving incremental file list$/

export const rsync: FilterSpec = {
  name: 'rsync',
  matchCommand: RSYNC,
  stripLinesMatching: [RSYNC_FILE_LINE, RSYNC_BANNER],
  maxLines: 30,
  headLines: 5,
  tailLines: 25,
}
```

**LOC estimado:** ~14.

**Bloqueios:**
- Regex `RSYNC_FILE_LINE` é frágil — pode bater em mensagens de erro tipo `rsync: failed: ...`. Precisa whitelist explícita de palavras-chave de erro (`rsync:`, `error`, `IO error`) ANTES do strip, ou usar `keepLinesMatching` em vez de `stripLinesMatching`.
- **Risco MÉDIO de falso positivo.** Validar com fixtures reais.

---

### 3.6 `ssh` — P2

**RTK (`ssh.toml`):** strip de linhas `debug1:` / `debug2:` / `debug3:` (verbosidade `-v`/`-vv`/`-vvv`).

**FilterSpec proposta:**
```ts
const SSH = /^ssh\b/
const SSH_DEBUG = /^debug\d+:\s/

export const ssh: FilterSpec = {
  name: 'ssh',
  matchCommand: SSH,
  stripLinesMatching: [SSH_DEBUG],
  maxLines: 50,
}
```

**LOC estimado:** ~8.

**Cuidado:** ssh interativo geralmente não passa por filtro (TTY); este filtro só ajuda em `ssh host 'command'` ou scripts. ROI moderado mas robusto.

**Bloqueios:** nenhum.

---

### 3.7 `stat` — P3

**RTK (`stat.toml`):** filtro curto que normaliza timestamps e quebra de linhas.

**Output típico já é pequeno (~8 linhas).** ROI baixo. Adicionar apenas se `stat *` em diretório grande aparecer com frequência.

**FilterSpec proposta:** mínima, `maxLines: 40`. **LOC: ~6.**

**Verdict:** **deferir.** Não está em P1/P2.

---

### 3.8 `dmesg` — P3

**RTK:** ❌ nenhum filtro.

**Output bruto:** centenas a milhares de linhas. Timestamp prefix `[12345.678]` ou `[Mon May 13 ...]`.

**Estratégia possível:**
- Tail apenas (últimas N linhas — mais recente é mais relevante)
- `keepLinesMatching` para `error`, `warn`, `fail`

**FilterSpec proposta:**
```ts
const DMESG = /^dmesg\b/

export const dmesg: FilterSpec = {
  name: 'dmesg',
  matchCommand: DMESG,
  maxLines: 60,
  headLines: 0,
  tailLines: 60,  // só o mais recente
}
```

**LOC estimado:** ~8.

**Bloqueios:** nenhum.

**Cuidado:** decisão head vs tail é empírica. Validar com amostra real antes de mergear.

---

### 3.9 `jq` — P2

**RTK (`src/cmds/system/json_cmd.rs`):** runner com **UTF-8 boundary safety** via `str::floor_char_boundary`. Trunca output JSON sem corromper unicode.

**Desafio principal:** `jq` é frequentemente parte de pipe (`curl ... | jq '.field'`) — output é dado estruturado que pode ser parseado adiante. **Filtrar é arriscado.**

**Estratégia recomendada:** `matchCommandReject` agressivo para pular qualquer invocação com flags que indicam consumo programático.

**FilterSpec proposta:**
```ts
const JQ = /^jq\b/
const JQ_STRUCTURED = /-r\b|--raw-output\b|-c\b|--compact-output\b|--tab\b|-j\b|--join-output\b/

export const jq: FilterSpec = {
  name: 'jq',
  matchCommand: JQ,
  matchCommandReject: JQ_STRUCTURED,
  maxLines: 100,
}
```

**LOC estimado:** ~8.

**Bloqueios:**
- Sem `maxBytes` UTF-8-safe, não dá para garantir non-corruption se o JSON é uma string única gigante (`jq '.'` em arquivo grande). Mitigação: `truncateLineAt` aceita char count, então uma linha gigante seria truncada — mas isso quebra o JSON.
- **Resolução pragmática:** só `maxLines`, sem `truncateLineAt`. Se for um output single-line gigante, deixa passar inteiro. Aceitar essa limitação até ter `maxBytes` UTF-8-safe.

---

### 3.10 `curl` extension — P1 (parcial pode ir já)

Detalhado em [`system-utils-deep-dive-2026-05.md` § Anexo curl](./system-utils-deep-dive-2026-05.md#anexo--curl-cobertura-atual-vs-rtk).

**Resumo do plano:**

| Parte | Pode mergear agora? | Bloqueio |
|---|---|---|
| Progress-bar stripping em `curl URL` (sem `-v`) | ✅ sim | nenhum, ~12 LOC |
| JSON-aware body passthrough | ❌ | precisa `maxBytes` + `matchOutput.passthroughIf` (RFC framework) |
| Body truncation a 500 B com `is_char_boundary` | ❌ | precisa `maxBytes` no framework |
| Skip filter em exit ≠ 0 | parcial | flag global `isError` existe; falta sinal por spec |

**Ação imediata (PR-4a, subset seguro):**

```ts
// network.ts — adicionar spec separada de curlV
const CURL_ANY = /^curl\b/
const CURL_BODY_REJECT = /-v\b|--verbose\b|-s\b|--silent\b|-I\b|--head\b|-o\s|--output\s/

const CURL_PROGRESS_HEADER = /^\s*%\s+Total\s+%\s+Received/
const CURL_PROGRESS_RULE = /^\s*Dload\s+Upload/
const CURL_PROGRESS_DATA = /^\s*\d+\s+\d+[kKMG]?\s+\d+\s+\d+[kKMG]?/

export const curlPlain: FilterSpec = {
  name: 'curl-plain',
  matchCommand: CURL_ANY,
  matchCommandReject: CURL_BODY_REJECT,  // -v cai pro curlV; -s/--silent já está limpo; -I/-o não tem body
  stripAnsi: true,
  stripLinesMatching: [CURL_PROGRESS_HEADER, CURL_PROGRESS_RULE, CURL_PROGRESS_DATA],
}
```

**LOC estimado:** ~12. **Bloqueio:** nenhum para esta parte.

---

## 4. Roadmap consolidado

### 4.1 PRs sem bloqueio (mergeáveis assim que houver capacidade)

| PR | Specs | LOC | Risco | Prioridade |
|---|---|---|---|---|
| PR-1 | `ping`, `rsync`, `tree` | ~36 | rsync regex frágil → validar fixtures | **P1** |
| PR-2 | `ssh`, `stat`, `df` | ~28 | baixo | **P1**/P3 mix |
| PR-3 | `dmesg`, `du` (mínima), `jq` | ~28 | dmesg head/tail empírico | P2/P3 |
| PR-4a | `curl-plain` (progress bar stripping) | ~12 | baixo | **P1** |
| PR-5 | Polish: `grep` add `stripAnsi+dedup`, `ls` add column-width hint | ~6 | baixo | P3 |

**Total LOC sem bloqueio: ~110 linhas de spec** + tests.

### 4.2 PRs bloqueados por RFC de framework

| PR | Spec | Bloqueio |
|---|---|---|
| PR-4b | `curl-body` (truncation + JSON passthrough) | precisa `maxBytes` UTF-8-safe + `matchOutput.passthroughIf` |
| PR-3-ext | `du` com sort | precisa capability `sortBy` |
| PR-6 | Skip filter por spec em exit ≠ 0 | precisa exposição de `exitCode` ao FilterSpec |
| PR-7 | `tee_and_hint` para recuperação de output truncado | feature totalmente nova (storage + recovery hint) |

### 4.3 RFC de framework recomendado (separar do roadmap de specs)

Antes (ou em paralelo) aos PRs bloqueados, abrir RFC para adicionar ao `FilterSpec`:

```ts
interface FilterSpec {
  // ...existentes...

  /** Corte em bytes com UTF-8 boundary check */
  maxBytes?: number

  /** Passa o output cru se primeira linha não-vazia bate o padrão (ex: JSON) */
  passthroughIf?: RegExp

  /** Não filtra se exit code != 0 (default: respeita global isError) */
  preserveOnError?: boolean

  /** Ordena linhas antes de aplicar maxLines/head/tail */
  sortBy?: { regex: RegExp; group: number; direction: 'asc' | 'desc'; numeric?: boolean }
}
```

Estes são **4 RFCs distintos**, podem ir um a um. Sem eles, ~4 specs ficam parcial (`curl-body`, `du`-sort, `ping` skip-on-error, recovery hint).

---

## 5. Decisões de NÃO implementar (skip deliberado)

Para o próximo implementador não perder tempo:

| Comando | Razão |
|---|---|
| `find` | RTK mediu ROI 0% — output já é nome de arquivo, não tem ruído estrutural |
| `wc` | Output naturalmente compacto (1-2 linhas) |
| `cat` / `head` / `tail` | Conteúdo é dado, não ruído. Filtrar é destruir informação. RTK também não tem (subsumido em `read.rs`) |
| `env` | Output é dado (variáveis). Filtrar tokens não ajuda; risco de leak. Levantar issue separada de **secret masking** (camada diferente, não output filter) |
| `top` (interativo) | TUI — não chega ao filter via captura |
| `stat` | Output já curto (~8 linhas). ROI baixo, postergar indefinidamente |

---

## 6. Onde colocar o código (módulo a módulo)

| Spec(s) | Arquivo destino | Justificativa |
|---|---|---|
| `ping`, `tree`, `df`, `du`, `ssh`, `stat`, `dmesg` | `src/outputFilter/Bash/filters/system.ts` (estender) | mesma família do `psAux`/`journalctl` |
| `rsync` | `src/outputFilter/Bash/filters/system.ts` ou criar `filesync.ts` | rsync é transferência, mas só uma spec — manter em `system.ts` |
| `jq` | `src/outputFilter/Bash/filters/system.ts` | utilitário de sistema-CLI |
| `curl-plain` | `src/outputFilter/Bash/filters/network.ts` (junto com `curlV` e `dig`) | já é o módulo de rede |

Registry: `src/outputFilter/Bash/filters/index.ts` — adicionar cada export na lista de 35 specs.

Tests: como confirmado pelo agente, **não há colocation**. Todos os testes vivem em:
- `src/outputFilter/Bash/bashFilter.test.ts` (testes por spec, agrupados em `describe("phase X — name")`)
- `src/outputFilter/Bash/registry.test.ts`
- `src/outputFilter/Bash/pipeline.test.ts`
- `src/outputFilter/Bash/cornerCases.test.ts`

Cada nova spec deve adicionar um `describe()` em `bashFilter.test.ts` com no mínimo:
- `ROI: sample ≥X% reduction` (medição empírica)
- `match: <command happy path>`
- `reject: <flag que deve dar passthrough>`
- `preserves: <linha crítica que NÃO pode ser strippada>` (especialmente `ping` statistics, `rsync` summary, `df` header)

---

## 7. Próximos passos sugeridos

1. **PR-1** (`ping` + `rsync` + `tree`) — maior ROI, sem bloqueios. Começar por aqui.
2. Validar `rsync` regex contra fixtures reais antes de mergear (risco de falso positivo).
3. PR-4a (`curl-plain` progress bar) — pode ir junto ou separado.
4. PR-2 (`ssh` + `df` + `stat`) — baixo risco.
5. Abrir RFC `maxBytes` no framework — desbloqueia `curl-body` e `jq` completos.
6. PR-3 (`dmesg` + `du`-mínima + `jq`-mínima).
7. RFC `sortBy` e `preserveOnError` se houver demanda.

LOC total mergeável sem RFC: ~110. Cobre 8 dos 12 gaps acionáveis. Os 4 restantes (`curl-body`, `du`-sort, `jq`-UTF8-safe, recovery hint) ficam para depois do RFC.
