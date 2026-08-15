# System utils — deep dive de refinamento

> Última atualização: 2026-05-13

Documento de contexto pai: [`./rtk-refinement-2026-05.md`](./rtk-refinement-2026-05.md) — esta nota foca **apenas** na família *system utils*, que dominam o volume de Bash em sessões reais (`cat`, `find`, `tail`, `ls`, `wc`, `jq`, `df`, `du`, `stat`, `ping`, `rsync`, `ssh`, `dmesg`, `env`, mais `tree`/`head`).

Escopo: 15 comandos. Sem implementação — só decisão e estrutura sugerida de [`FilterSpec`](../../../../src/tools/shared/outputFilter/Bash/types.ts).

Sumário rápido:

| comando | recomendação | ROI | depende de helper novo? |
|---|---|---|---|
| `cat` | SKIP | — | — |
| `head` | SKIP | — | — |
| `tail` | SKIP | — | — |
| `find` | SKIP | BAIXO (medido 0%) | — |
| `tree` | PORT | ALTO | — |
| `wc` | SKIP | BAIXO | — |
| `jq` | ADAPT | MÉDIO | — |
| `df` | PORT | MÉDIO | — |
| `du` | PORT | BAIXO-MÉDIO | — |
| `stat` | PORT | MÉDIO | — |
| `ping` | PORT | ALTO | — |
| `rsync` | ADAPT | ALTO | matchOutput com `unless` |
| `ssh` | PORT | MÉDIO-ALTO | — |
| `dmesg` | ADAPT | MÉDIO | — |
| `env` | SKIP | BAIXO | — |

LOC totais estimados em ~220 linhas TS (com regex e comentários), sem testes. Testes adicionais somam ~150 linhas.

---

## 1. `cat`

**Padrão de uso**

```bash
cat src/foo.ts
cat README.md package.json
```

**Output verboso típico**

Conteúdo literal do arquivo. Não há ruído estrutural.

**O que stripar:** nada — content é signal puro.

**O que preservar:** tudo.

**Estratégia RTK:** handler [`cmds/system/read.rs`](../../../../rtk/src/cmds/system/read.rs) implementa `rtk read` com `FilterLevel` opcional + `max_lines/tail_lines`. RTK **não filtra `cat` automaticamente** — substitui pelo subcomando `rtk read` apenas quando o usuário escolhe.

**Recomendação Claudin:** **SKIP**. Já documentado em [`commands/cat.md`](./commands/cat.md). Claudin tem `FileReadTool` dedicado; `cat` no Bash é fallback raro e o summarizer global já cobre output >10KB.

**matchCommandReject obrigatório:** N/A (sem filter).

**ROI estimado:** BAIXO — content é 100% sinal, modificar é arriscado (binário, JSON, etc).

```ts
// nenhum FilterSpec — passthrough explícito
```

---

## 2. `head`

**Padrão de uso**

```bash
head -50 src/app.log
head -n 20 README.md
```

**Output verboso típico:** content já truncado pelo usuário.

**O que stripar:** nada.

**Estratégia RTK:** sem spec dedicada (`read.rs` aceita `--tail-lines`/`--max-lines` no subcomando `rtk read`).

**Recomendação Claudin:** **SKIP**. O usuário já escolheu o tamanho. Filtrar seria duplo-corte.

**ROI estimado:** BAIXO — output já é limitado por design.

---

## 3. `tail`

**Padrão de uso**

```bash
tail -n 100 /var/log/syslog
tail -f app.log     # follow
```

**Output verboso típico:** últimas N linhas do arquivo; em logs costuma ser denso.

**O que stripar:** nada — é exatamente o que o usuário pediu.

**Estratégia RTK:** sem spec dedicada. `rtk log` (handler [`cmds/system/log_cmd.rs`](../../../../rtk/src/cmds/system/log_cmd.rs)) faz dedup com normalização (TIMESTAMP, UUID, HEX, NUM, PATH) — mas o usuário precisa pedir explicitamente.

**Recomendação Claudin:** **SKIP** no v1. `tail -f` nem entra em filter (stream contínuo). Para `tail` sobre logs com repetição podemos considerar v2: um modo opcional de dedup similar ao `log_cmd.rs`, mas só vale se medirmos volume real.

**ROI estimado:** BAIXO — user já limitou o tamanho. Patrões repetitivos em logs ficam para um filter dedicado a `journalctl`/`dmesg`, não a `tail`.

---

## 4. `find`

**Padrão de uso**

```bash
find . -name "*.ts" -not -path "./node_modules/*"
find /var/log -mtime -1
```

**Output verboso típico**

```
./src/foo.ts
./src/bar.ts
find: './restricted': Permission denied
./src/baz.ts
```

**O que stripar:** linhas `^find: .*: Permission denied$` deduplicadas em uma única linha-marker.

**O que preservar:** todos os paths encontrados (são coordenadas).

**Estratégia RTK:** handler [`find_cmd.rs`](../../../../rtk/src/cmds/system/find_cmd.rs) usa `ignore::WalkBuilder` e agrupa por diretório — substitui o `find` nativo. Não há spec declarativa.

**Recomendação Claudin:** **SKIP**. Doc detalhado em [`commands/find.md`](./commands/find.md) mediu **ROI ~0%** no uso real (usuários já filtram com `-not -path`). Claudin tem `GlobTool` dedicado. Manter passthrough; se aparecer demanda, reintroduzir como Tier-3.

**matchCommandReject obrigatório (se reintroduzir):** `-print0|-exec\b|-printf\b|-quit\b` para não tocar saídas estruturadas / NUL-separated.

**ROI estimado:** BAIXO — empiricamente medido 0% em sessões reais.

---

## 5. `tree`

**Padrão de uso**

```bash
tree -L 2
tree src/
```

**Output verboso típico**

```
.
├── docs
│   ├── advanced-setup.md
│   └── plans
├── node_modules
│   ├── @anthropic-ai
│   └── ... (300+ entries)
└── package.json

15 directories, 47 files
```

**O que stripar:**
- Sumário final `^\d+ director(?:y|ies), \d+ files?$`
- Subtrees de noise dirs: linhas que começam com decoração `[│├└─ ]+` seguida de `(node_modules|\.git|target|dist|build|__pycache__|\.venv|\.cache|\.next)/?$` e os filhos imediatos sob esses diretórios.

**O que preservar:** estrutura ASCII art (`├── │ └──`), filenames, root header.

**Estratégia RTK:** handler [`tree.rs`](../../../../rtk/src/cmds/system/tree.rs) injeta `-I <noise_dirs>` no comando antes de executar (command rewrite) e pós-processa removendo a linha de sumário. Reutiliza `NOISE_DIRS` de [`constants.rs`](../../../../rtk/src/cmds/system/constants.rs).

**Recomendação Claudin:** **PORT** (declarativo + rewrite opcional). Spec mínima cobre 80% do ganho via `stripLinesMatching` + cap. Em v2 considerar `rewriteCommand` para injetar `-I` quando o usuário não passou `--all`/`-a`/`-I`.

**matchCommandReject obrigatório:** `--json\b|--xml\b|--noreport\b` (output estruturado ou já sem sumário) e `-J\b`.

**ROI estimado:** ALTO — em monorepos sem `-L` o output explode; mesmo com `-L 2` o filtro corta 10–15% via sumário.

**FilterSpec sugerida**

```ts
const TREE_MATCH = /^tree(\s|$)/
const TREE_REJECT = /(?:^|\s)(?:--json|--xml|--noreport|-J)\b/
const TREE_SUMMARY = /^\d+\s+director(?:y|ies),\s+\d+\s+files?\.?$/
const TREE_NOISE_BRANCH =
  /^[│├└─\s]*(?:node_modules|\.git|target|dist|build|__pycache__|\.venv|\.cache|\.next)\/?$/

export const tree: FilterSpec = {
  name: 'tree',
  matchCommand: TREE_MATCH,
  matchCommandReject: TREE_REJECT,
  stripAnsi: true,
  stripLinesMatching: [TREE_SUMMARY, TREE_NOISE_BRANCH],
  maxLines: 200,
}
```

---

## 6. `wc`

**Padrão de uso**

```bash
wc -l src/**/*.ts
wc file.py
```

**Output verboso típico**

```
  30  96 978 file.py
  42 112 1234 other.py
  72 208 2212 total
```

**O que stripar:** padding/alignment é o único ruído real, mas mexer em colunas exige parsing — não cabe em pipeline declarativo.

**Estratégia RTK:** handler [`wc_cmd.rs`](../../../../rtk/src/cmds/system/wc_cmd.rs) detecta `WcMode` (Full/Lines/Words/Bytes/Chars/Mixed), strip de prefixo comum em paths, e comprime para formato `30L 96W 978B`. **Não há TOML** — é parser custom.

**Recomendação Claudin:** **SKIP** na v1. Output já é compacto (uma linha por arquivo) e fazer compressão equivalente exigiria handler dedicado. ROI insuficiente.

**matchCommandReject obrigatório (se um dia portar):** `--bytes\b|--max-line-length\b` quando combinado com flags machine-readable.

**ROI estimado:** BAIXO — `wc` raramente domina o byte-count de uma sessão.

---

## 7. `jq`

**Padrão de uso**

```bash
jq '.dependencies' package.json
cat foo.json | jq '.users[] | select(.active)'
```

**Output verboso típico**

```
{
  "name": "claudin",
  "version": "0.2.1",
  "dependencies": {
    "zod": "^4.0.0",
    "ink": "^5.0.0",
    ...
  }
}
```

**O que stripar:** linhas em branco (raras em JSON pretty-printed). Conteúdo em si é signal — não filtrar valores.

**O que preservar:** **JSON válido**. Modificar conteúdo quebra qualquer consumer downstream.

**Estratégia RTK:** [`jq.toml`](../../../../rtk/src/filters/jq.toml) — `max_lines=40`, `truncate_lines_at=120`, `strip_ansi`, strip de linhas vazias. Modelo cru: cap duro de altura sem mexer no shape.

**Recomendação Claudin:** **ADAPT**. O cap por linhas é seguro **só se preservarmos JSON parseável** — qualquer corte no meio do output gera JSON inválido. Solução: aplicar `maxLines` apenas com `onEmpty`/marker explícito ("output truncado, JSON pode estar incompleto"), e bloquear via `matchCommandReject` quando o usuário pedir output cru ou compacto.

**matchCommandReject obrigatório:** `(?:^|\s)(?:-c|--compact-output|-r|--raw-output|-R|--raw-input|-j|--join-output|--slurp|-s|--tab|--seq)\b`. Em modos `-r`/`-j`/`-c` o output é uma única linha ou stream linha-a-linha — cortar quebra parsing.

**ROI estimado:** MÉDIO — payloads JSON grandes (npm registry, kubectl get -o json piped para jq, AWS list-*) são fonte recorrente de 5–20k tokens por chamada. Truncate em 120 cols + 40 linhas corta ~70% nesses casos.

**FilterSpec sugerida**

```ts
const JQ_MATCH = /^jq\b/
const JQ_REJECT =
  /(?:^|\s)(?:-c|--compact-output|-r|--raw-output|-R|--raw-input|-j|--join-output|--slurp|-s|--tab|--seq)\b/
const JQ_BLANK = /^\s*$/

export const jq: FilterSpec = {
  name: 'jq',
  matchCommand: JQ_MATCH,
  matchCommandReject: JQ_REJECT,
  stripAnsi: true,
  stripLinesMatching: [JQ_BLANK],
  maxLines: 40,
  truncateLineAt: 120,
  onEmpty: '(jq output empty)',
}
```

> Cuidado: `truncateLineAt` corta colunas no meio de strings JSON, então o output pós-filter **não deve ser passado adiante como JSON parseável** pelo modelo. Isso é aceitável porque o modelo lê o output, não o consome programaticamente.

---

## 8. `df`

**Padrão de uso**

```bash
df -h
df -h /home /var
```

**Output verboso típico**

```
Filesystem      Size  Used Avail Use% Mounted on
tmpfs           1.6G  2.5M  1.6G   1% /run
/dev/nvme0n1p2  457G  198G  236G  46% /
tmpfs           7.8G   54M  7.7G   1% /dev/shm
efivarfs        128K  120K  4.0K  97% /sys/firmware/efi/efivars
```

**O que stripar:** nada estrutural. `df` é tabular e curto por natureza.

**O que preservar:** tudo. Em sistemas com muitos mounts, cap em ~20 linhas.

**Estratégia RTK:** [`df.toml`](../../../../rtk/src/filters/df.toml) — `max_lines=20`, `truncate_lines_at=80`, `strip_ansi=true`. Sem `strip_lines_matching` nem `match_output` — só guarda contra `df` em servidores com 100+ mounts (NFS farm, containers).

**Recomendação Claudin:** **PORT** direto. Tradução 1:1 da spec TOML.

**matchCommandReject obrigatório:** `(?:^|\s)(?:--output=|--json\b)` quando aplicável (df do `coreutils` aceita `--output=field,…` para CSV-like e plugins têm JSON).

**ROI estimado:** MÉDIO — em servidores com tmpfs/overlayfs/containers o output passa 30+ linhas. Em laptop comum, ~5 linhas (passthrough efetivo).

**FilterSpec sugerida**

```ts
const DF_MATCH = /^df\b/
const DF_REJECT = /(?:^|\s)(?:--output=|--json)\b/

export const df: FilterSpec = {
  name: 'df',
  matchCommand: DF_MATCH,
  matchCommandReject: DF_REJECT,
  stripAnsi: true,
  maxLines: 20,
  truncateLineAt: 80,
}
```

---

## 9. `du`

**Padrão de uso**

```bash
du -sh *
du -h --max-depth=2 /var/log
```

**Output verboso típico**

```
4.0K    ./src
8.0K    ./tests

16K     .
```

**O que stripar:** linhas em branco. Sem mais.

**O que preservar:** tamanhos e paths.

**Estratégia RTK:** [`du.toml`](../../../../rtk/src/filters/du.toml) — `max_lines=40`, `truncate_lines_at=120`, `strip_lines_matching=["^\s*$"]`.

**Recomendação Claudin:** **PORT** direto. Cap de 40 linhas cobre o caso `du -h --max-depth=N` que é o uso comum.

**matchCommandReject obrigatório:** `(?:^|\s)(?:--null|-0|--inodes)\b` (NUL-separated quebra contagem de linha; `--inodes` muda a semântica mas a forma é a mesma — manter no escopo).

**ROI estimado:** BAIXO-MÉDIO — `du` raramente passa de ~20 linhas em uso interativo; `du -a` sem cap explode.

**FilterSpec sugerida**

```ts
const DU_MATCH = /^du\b/
const DU_REJECT = /(?:^|\s)(?:--null|-0)\b/
const DU_BLANK = /^\s*$/

export const du: FilterSpec = {
  name: 'du',
  matchCommand: DU_MATCH,
  matchCommandReject: DU_REJECT,
  stripAnsi: true,
  stripLinesMatching: [DU_BLANK],
  maxLines: 40,
  truncateLineAt: 120,
}
```

---

## 10. `stat`

**Padrão de uso**

```bash
stat src/foo.ts
stat -c '%n %s %y' *.json
```

**Output verboso típico**

```
  File: main.rs
  Size: 12345           Blocks: 24         IO Block: 4096   regular file
Device: 801h/2049d      Inode: 1234567     Links: 1
Access: (0644/-rw-r--r--)  Uid: ( 1000/ patrick)   Gid: ( 1000/ patrick)
Access: 2026-03-10 12:00:00.000000000 +0100
Modify: 2026-03-10 11:00:00.000000000 +0100
Change: 2026-03-10 11:00:00.000000000 +0100
 Birth: 2026-03-09 10:00:00.000000000 +0100
```

**O que stripar:** linhas `^\s*Device:` e `^\s*Birth:` (raramente úteis para o coding agent).

**O que preservar:** `File:`, `Size:`, `Access:`, `Modify:`, `Change:`, permissões.

**Estratégia RTK:** [`stat.toml`](../../../../rtk/src/filters/stat.toml) — strip de `Device:` e `Birth:`, blank lines, `truncate=120`, `max_lines=20`.

**Recomendação Claudin:** **PORT** direto.

**matchCommandReject obrigatório:** `(?:^|\s)(?:-c|--format=|--printf=|--terse|-t)\b` — esses modos produzem output single-line formatado pelo usuário; nada para stripar.

**ROI estimado:** MÉDIO — `stat` é chamado em diagnósticos de permissão/timestamp. Strip de 2 linhas em 8 = ~25% por invocação.

**FilterSpec sugerida**

```ts
const STAT_MATCH = /^stat\b/
const STAT_REJECT = /(?:^|\s)(?:-c|--format=|--printf=|--terse|-t)\b/
const STAT_DEVICE = /^\s*Device:/
const STAT_BIRTH = /^\s*Birth:/
const STAT_BLANK = /^\s*$/

export const stat: FilterSpec = {
  name: 'stat',
  matchCommand: STAT_MATCH,
  matchCommandReject: STAT_REJECT,
  stripAnsi: true,
  stripLinesMatching: [STAT_DEVICE, STAT_BIRTH, STAT_BLANK],
  maxLines: 20,
  truncateLineAt: 120,
}
```

---

## 11. `ping`

**Padrão de uso**

```bash
ping -c 4 example.com
ping 8.8.8.8
```

**Output verboso típico**

```
PING example.com (93.184.216.34): 56 data bytes
64 bytes from 93.184.216.34: icmp_seq=0 ttl=56 time=14.2 ms
64 bytes from 93.184.216.34: icmp_seq=1 ttl=56 time=13.8 ms
64 bytes from 93.184.216.34: icmp_seq=2 ttl=56 time=14.1 ms
64 bytes from 93.184.216.34: icmp_seq=3 ttl=56 time=13.9 ms

--- example.com ping statistics ---
4 packets transmitted, 4 packets received, 0.0% packet loss
round-trip min/avg/max/stddev = 13.8/14.0/14.2/0.2 ms
```

**O que stripar:**
- Cabeçalho `^PING `/`^Pinging ` (banner inicial)
- Linhas per-packet `^\d+ bytes from ` (Linux/macOS) e `^Reply from .+: bytes=` (Windows)
- Blank lines

**O que preservar:** **o bloco de estatísticas final** (3–4 últimas linhas). Se houver `Request timeout` ou erro, **preservar também** — usuário precisa ver loss.

**Estratégia RTK:** [`ping.toml`](../../../../rtk/src/filters/ping.toml) — `strip_lines_matching` cobre os 4 padrões acima + blank, e usa `tail_lines=4` para garantir as estatísticas. O test inclui caso de `Request timeout` em que erros sobrevivem porque o strip é por linha (ackq não toca lines que não matcham).

**Recomendação Claudin:** **PORT** direto. Conjugar `stripLinesMatching` + `tailLines` exatamente como o TOML — note que `tailLines` no Claudin é aplicado **depois** do strip, então erros não-strippados que caíram fora das últimas 4 linhas seriam perdidos. **Cuidado:** confirmar a ordem do pipeline atual antes do PR; se necessário, usar `maxLines` em vez de `tailLines` para evitar engolir `Request timeout` em pings longos.

**matchCommandReject obrigatório:** `(?:^|\s)(?:-q|--quiet|-D\b|-O\b|-A\b)\b` — `-q` já produz só o sumário; nada para filtrar.

**ROI estimado:** ALTO — `ping -c 100` ou ping sem `-c` (interrompido com Ctrl-C) gera 100+ linhas onde só a cauda interessa. Reduções de 90%+ nessas chamadas.

**FilterSpec sugerida**

```ts
const PING_MATCH = /^ping\b/
const PING_REJECT = /(?:^|\s)(?:-q|--quiet)\b/
const PING_HEADER = /^PING /
const PING_HEADER_WIN = /^Pinging /
const PING_PACKET = /^\d+ bytes from /
const PING_PACKET_WIN = /^Reply from .+: bytes=/
const PING_BLANK = /^\s*$/

export const ping: FilterSpec = {
  name: 'ping',
  matchCommand: PING_MATCH,
  matchCommandReject: PING_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    PING_HEADER,
    PING_HEADER_WIN,
    PING_PACKET,
    PING_PACKET_WIN,
    PING_BLANK,
  ],
  // Preservar timeouts/erros: usar maxLines (não tailLines puro) para evitar
  // engolir "Request timeout" em pings longos. tailLines=4 só é seguro quando
  // confirmado que strip ocorre antes do corte.
  maxLines: 12,
}
```

---

## 12. `rsync`

**Padrão de uso**

```bash
rsync -avz src/ user@host:/dst/
rsync -a backup/ /mnt/external/backup/
```

**Output verboso típico**

```
sending incremental file list
./
file1.txt
file2.txt
file3.txt
...
sent 1,234 bytes  received 42 bytes  2,552.00 bytes/sec
total size is 98,765  speedup is 77.31
```

**O que stripar:**
- `^sending incremental file list`
- `^sent \d` (linha de bytes — redundante com `total size is`)
- Blank lines

**O que preservar:**
- **Linhas `^rsync:` e `^rsync error:`** — críticas para diagnóstico
- Linha final `total size is N speedup is M` (ou substituir por `ok (synced)` em short-circuit)

**Estratégia RTK:** [`rsync.toml`](../../../../rtk/src/filters/rsync.toml) — combina `strip_lines_matching` + `match_output` com `unless="error|failed|No such file"` (short-circuit para `ok (synced)`). Os testes confirmam que erros **não** são engolidos pelo short-circuit graças ao `unless`.

**Recomendação Claudin:** **ADAPT**. O Claudin já suporta `matchOutput` com `unless` (ver [`linters.ts`](../../../../src/tools/shared/outputFilter/Bash/filters/linters.ts) — `ruffCheck` usa o mesmo padrão). Adaptar para usar a regex `unless` reforçada (incluir também `Permission denied` e `code \d+`).

**matchCommandReject obrigatório:** `(?:^|\s)(?:--progress|-P|--info=progress2|-v{2,}|--itemize-changes|-i)\b` — `--progress` muda o formato (carriage returns, percentuais), e `-i`/`--itemize-changes` produz output estruturado que vale preservar.

**ROI estimado:** ALTO — sync de árvores grandes gera 1000+ linhas; short-circuit para `ok (synced)` corta ~99% nos casos sucesso. Casos de falha mantêm os 2-3 erros visíveis.

**FilterSpec sugerida**

```ts
const RSYNC_MATCH = /^rsync\b/
const RSYNC_REJECT =
  /(?:^|\s)(?:--progress|-P|--info=progress2|--itemize-changes|-i|-vv+)\b/
const RSYNC_HEADER = /^sending incremental file list/
const RSYNC_SENT = /^sent \d/
const RSYNC_BLANK = /^\s*$/
const RSYNC_OK = /^total size is /m
const RSYNC_HAS_PROBLEM =
  /\b(?:error|failed|No such file|Permission denied|code\s+\d+)\b/i

export const rsync: FilterSpec = {
  name: 'rsync',
  matchCommand: RSYNC_MATCH,
  matchCommandReject: RSYNC_REJECT,
  stripAnsi: true,
  stripLinesMatching: [RSYNC_HEADER, RSYNC_SENT, RSYNC_BLANK],
  matchOutput: [
    {
      pattern: RSYNC_OK,
      unless: RSYNC_HAS_PROBLEM,
      message: 'ok (synced)',
    },
  ],
  maxLines: 20,
}
```

---

## 13. `ssh`

**Padrão de uso**

```bash
ssh user@host 'ls /var/log'
ssh -v user@host
```

**Output verboso típico**

```
Warning: Permanently added '192.168.1.10' (ED25519) to the list of known hosts.

total 32
drwxr-xr-x 4 user user 4096 Mar 10 12:00 app
-rw-r--r-- 1 user user 1234 Mar 10 11:00 config.yaml

Connection to 192.168.1.10 closed.
```

Com `-v` ou `StrictHostKeyChecking=no`:

```
OpenSSH_9.6p1, OpenSSL 3.0.0
debug1: Reading configuration data /etc/ssh/ssh_config
debug1: Connecting to host.example.com port 22.
debug1: Connection established.
Authenticated to host.example.com ([1.2.3.4]:22).
Pseudo-terminal will not be allocated because stdin is not a terminal.
... (real command output)
Connection to host.example.com closed.
```

**O que stripar:**
- `^Warning: Permanently added`
- `^Connection to .+ closed`
- `^Authenticated to`
- `^debug1:` (e em geral `^debug\d+:`)
- `^OpenSSH_`
- `^Pseudo-terminal`
- Blank lines

**O que preservar:** stdout/stderr do comando remoto.

**Estratégia RTK:** [`ssh.toml`](../../../../rtk/src/filters/ssh.toml) — todas as regex acima + `max_lines=200`, `truncate=120`. Sem `match_output` (não há "ok" universal num ssh).

**Recomendação Claudin:** **PORT** com pequena melhoria: estender `^debug1:` para `^debug\d+:` para cobrir `-vv`/`-vvv`. Cap em 200 linhas é generoso e seguro.

**matchCommandReject obrigatório:**
- `(?:^|\s)(?:-T|-N|-q)\b` — `-q` já suprime warnings; `-N`/`-T` produz output mínimo
- `(?:^|\s)(?:-W|-L|-R|-D)\s` — port forwarding; output é normalmente vazio
- `\bscp\b|\bsftp\b` — não confundir com `scp`/`sftp` (são binários separados, mas defesa contra wrappers)

**Cuidado especial:** `ssh -o StrictHostKeyChecking=no -v` em CI/scripts é o caso mais ruidoso. Os 7 padrões cobrem ~95% do banner.

**ROI estimado:** MÉDIO-ALTO — quando o usuário inclui `-v` ou ambiente está com debug, banner consome 20–50 linhas antes do output útil. Em chamadas silenciosas, passthrough efetivo.

**FilterSpec sugerida**

```ts
const SSH_MATCH = /^ssh\b/
const SSH_REJECT = /(?:^|\s)(?:-q|-T|-N)\b/
const SSH_WARNING = /^Warning: Permanently added/
const SSH_CLOSED = /^Connection to .+ closed/
const SSH_AUTH = /^Authenticated to/
const SSH_DEBUG = /^debug\d+:/
const SSH_BANNER = /^OpenSSH_/
const SSH_PTY = /^Pseudo-terminal/
const SSH_BLANK = /^\s*$/

export const ssh: FilterSpec = {
  name: 'ssh',
  matchCommand: SSH_MATCH,
  matchCommandReject: SSH_REJECT,
  stripAnsi: true,
  stripLinesMatching: [
    SSH_WARNING,
    SSH_CLOSED,
    SSH_AUTH,
    SSH_DEBUG,
    SSH_BANNER,
    SSH_PTY,
    SSH_BLANK,
  ],
  maxLines: 200,
  truncateLineAt: 120,
}
```

---

## 14. `dmesg`

**Padrão de uso**

```bash
dmesg | tail -50
sudo dmesg -T --level=err,warn
```

**Output verboso típico**

```
[    0.000000] microcode: microcode updated early to revision 0xf0, date = 2023-02-15
[    0.000000] Linux version 6.6.0-arch ...
[    0.123456] ACPI: Early table checksum verification disabled
[    1.234567] usb 1-1: new high-speed USB device number 2 using xhci_hcd
...
[12345.678] EXT4-fs (nvme0n1p2): mounted filesystem with ordered data mode
```

**O que stripar:**
- Em runs verbose: blank lines.
- Mensagens repetitivas com timestamps diferentes (semelhante a `journalctl`) — substituir prefixo `^\[ *\d+\.\d+\] ` por nada se quisermos dedup, mas isso é agressivo demais para v1.

**O que preservar:** mensagens de erro/warning, falhas de driver, OOM, segfault.

**Estratégia RTK:** **sem TOML dedicado**. RTK não tem `dmesg.toml` — passthrough nativo. Há overlap parcial com `log_cmd.rs` (handler `rtk log`) que faz dedup via normalização de timestamp/UUID/HEX/NUM/PATH, mas só quando o usuário invoca `rtk log` explicitamente.

**Recomendação Claudin:** **ADAPT** — não há referência RTK direta, mas o padrão de `journalctl` em [`system.ts`](../../../../src/tools/shared/outputFilter/Bash/filters/system.ts) serve de molde. Strip do prefixo de timestamp `^\[ *\d+\.\d+\] ` via `replace` ajuda dedup downstream e economiza ~20 chars/linha, mas perde info temporal. Decisão conservadora: **só strip blank + cap por linhas**, sem mexer no timestamp.

**matchCommandReject obrigatório:** `(?:^|\s)(?:--follow|-w|--json\b|-J)\b` — modo follow é stream, JSON é estruturado.

**Cuidado especial:** `dmesg -T` substitui o timestamp por data legível (`[Mon May 13 ...]`) — a regex de timestamp acima não mata isso, mas qualquer replace agressivo deve cobrir os dois formatos. Por isso a recomendação é não mexer.

**ROI estimado:** MÉDIO — `dmesg` sem grep produz 500-2000 linhas em sistemas com uptime alto; cap em 100 linhas (preservando o final via `tailLines`?) é o win mais simples. Verificar empiricamente antes de decidir entre `maxLines` (head) e `tailLines` (boot recente é geralmente mais relevante).

**FilterSpec sugerida**

```ts
const DMESG_MATCH = /^(?:sudo\s+)?dmesg\b/
const DMESG_REJECT = /(?:^|\s)(?:--follow|-w|--json|-J)\b/
const DMESG_BLANK = /^\s*$/

export const dmesg: FilterSpec = {
  name: 'dmesg',
  matchCommand: DMESG_MATCH,
  matchCommandReject: DMESG_REJECT,
  stripAnsi: true,
  stripLinesMatching: [DMESG_BLANK],
  // tail é mais útil que head: usuário quer ver últimos eventos.
  tailLines: 100,
  truncateLineAt: 200,
}
```

---

## 15. `env`

**Padrão de uso**

```bash
env
env | grep AWS_
```

**Output verboso típico**

```
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:...
HOME=/home/dev
SHELL=/bin/bash
LANG=en_US.UTF-8
... (50-200 entries)
AWS_ACCESS_KEY_ID=AKIA...
GITHUB_TOKEN=ghp_...
```

**O que stripar:** nada estrutural — cada linha é `KEY=VALUE`.

**O que preservar:** tudo.

**Cuidado crítico:** **secrets**. `env` em CI/local exibe `AWS_ACCESS_KEY_ID`, `GITHUB_TOKEN`, `OPENAI_API_KEY`, etc. O `rtk env_cmd.rs` faz mask em valores cujo nome bate com `(key|secret|password|token|credential|auth|private|jwt)`. Replicar isso no Claudin seria desejável **mas é decisão de produto**, não de filtro de output:
- Se mascararmos, mudamos o contrato (usuário pediu `env`, recebe mascarado).
- Se não mascararmos, o secret entra no histórico/contexto do modelo.

**Estratégia RTK:** [`env_cmd.rs`](../../../../rtk/src/cmds/system/env_cmd.rs) categoriza vars (PATH/lang/cloud/tool/other), trunca valores >100 chars, mascara secrets. Substitui o `env` nativo.

**Recomendação Claudin:** **SKIP** na v1. Não é problema de tokens, é problema de privacy — fora do escopo deste filtro. Open question separada: criar uma camada de masking de secrets aplicada **antes** de output entrar no contexto (cross-tool, não só Bash). Ver issue futura.

**matchCommandReject obrigatório (se um dia portar):** `(?:^|\s)(?:-0|--null|-u|--unset)\b` — `-0` é NUL-separated, `-u` muda semântica.

**ROI estimado:** BAIXO — `env` raramente é chamado em loop. Quando é, o volume é pequeno (~50 linhas).

```ts
// nenhum FilterSpec — passthrough explícito.
// Privacy/secret-masking deve viver em outra camada.
```

---

## Ordem de implementação recomendada

1. **`ping`** — ROI ALTO, spec curtíssima (5 regex + cap), padrão idêntico ao `dig`. Boa primeira PR para validar o pipeline `stripLinesMatching` + `maxLines` em comando de rede com saída multi-linha previsível.
2. **`rsync`** — ROI ALTO, exercita `matchOutput.unless` (precedente já em `ruffCheck`). Validar que short-circuit não engole erros.
3. **`tree`** — ROI ALTO em monorepos, spec simples sem `matchOutput`. Reaproveita lista `NOISE_DIRS` que pode virar export compartilhado com futuras specs.
4. **`ssh`** — ROI MÉDIO-ALTO, 6 regex de banner. Validar `^debug\d+:` em runs `-vv`.
5. **`stat`** — ROI MÉDIO, port direto. Cobertura de `matchCommandReject` para `-c`/`--format=`.
6. **`df`** — ROI MÉDIO, spec mínima (só cap). Baseline para medir efeito em sessões "cloudops".
7. **`du`** — ROI BAIXO-MÉDIO, port direto. Fechar a tríade `df`/`du`/`stat` numa única PR é razoável.
8. **`jq`** — ROI MÉDIO mas exige cuidado com `matchCommandReject` agressivo. Por último na lista de "implementar".
9. **`dmesg`** — ROI MÉDIO mas precisa medir empiricamente antes de escolher `head`/`tail`. Deixar até termos amostras reais.

Adiar: `cat`, `head`, `tail`, `find`, `wc`, `env` (justificativas em cada seção).

## Tabela síntese

| comando | recomendação | ROI | LOC est. (spec+regex) | helper novo? |
|---|---|---|---:|---|
| `cat` | SKIP | BAIXO | 0 | não |
| `head` | SKIP | BAIXO | 0 | não |
| `tail` | SKIP | BAIXO | 0 | não |
| `find` | SKIP | BAIXO (0% medido) | 0 | não |
| `tree` | PORT | ALTO | ~20 | (opcional) compartilhar `NOISE_DIRS` |
| `wc` | SKIP | BAIXO | 0 | não (precisaria handler) |
| `jq` | ADAPT | MÉDIO | ~18 | não |
| `df` | PORT | MÉDIO | ~12 | não |
| `du` | PORT | BAIXO-MÉDIO | ~14 | não |
| `stat` | PORT | MÉDIO | ~18 | não |
| `ping` | PORT | ALTO | ~22 | não |
| `rsync` | ADAPT | ALTO | ~28 | não (matchOutput.unless já existe) |
| `ssh` | PORT | MÉDIO-ALTO | ~26 | não |
| `dmesg` | ADAPT | MÉDIO | ~14 | não |
| `env` | SKIP | BAIXO (privacy concern) | 0 | sim (secret masker fora desta camada) |
| `curl` (body+progress) | EXTEND | ALTO | ~30 | sim (depende de `maxBytes` / JSON-aware passthrough) |

LOC total estimado: ~202 linhas de spec TS (sem testes), distribuíveis em 4 PRs:
- PR-1: `ping`, `rsync`, `tree` (~70 LOC)
- PR-2: `ssh`, `stat`, `df`, `du` (~70 LOC)
- PR-3: `jq`, `dmesg` (~32 LOC)
- PR-4: `curl` extension (~30 LOC) — bloqueado por suporte a body-truncation no framework

## Anexo — `curl` (cobertura atual vs RTK)

Mantemos hoje só o caminho `curl -v` (TLS/handshake stripping em [`network.ts`](../../../../src/tools/shared/outputFilter/Bash/filters/network.ts)). O RTK ([`curl_cmd.rs`](../../../../rtk/src/cmds/cloud/curl_cmd.rs)) é um *runner* (substitui o binário) e cobre dimensões que um filtro post-hoc não alcança sem extensão do framework.

### Cobertura

| Dimensão | RTK | Claudin | Gap |
|---|---|---|---|
| `curl -v` TLS/SSL/handshake | n/a (RTK injeta `-s`) | ✅ `curlV` strip | — |
| Progress bar (`% Total %Received`) em `curl URL` sem `-s` | suprimido via `-s` automático | ❌ passa cru | ALTO |
| JSON body passthrough garantido | regex `^[{["]` | ❌ sem detecção | médio (preciso para PR-4) |
| Body não-JSON grande | trunca a 500 B + tee-hint | ❌ sem truncamento | ALTO |
| Não-TTY (pipe/redirect) | passthrough completo | n/a (sempre captura) | n/a |
| Exit ≠ 0 | passthrough do stderr cru | ❌ filtra mesmo em erro | médio |
| UTF-8 boundary safe ao truncar | `is_char_boundary` | n/a (não trunca ainda) | — |

### Spec proposta (PR-4)

```ts
// network.ts — adicionar
const CURL_ANY = /^curl\b/
// passthrough quando usuário já pediu silêncio, headers-only, ou output em arquivo
const CURL_BODY_REJECT = /-s\b|--silent\b|-I\b|--head\b|-o\s|--output\s/

// Progress bar: header + linhas de dados
const CURL_PROGRESS_HEADER = /^\s*%\s+Total\s+%\s+Received/
const CURL_PROGRESS_RULE = /^\s*Dload\s+Upload/
const CURL_PROGRESS_DATA = /^\s*\d+\s+\d+[kKMG]?\s+\d+\s+\d+[kKMG]?/

export const curlBody: FilterSpec = {
  name: 'curl-body',
  matchCommand: CURL_ANY,
  matchCommandReject: CURL_BODY_REJECT,
  stripAnsi: true,
  stripLinesMatching: [CURL_PROGRESS_HEADER, CURL_PROGRESS_RULE, CURL_PROGRESS_DATA],
  // TODO(PR-4): maxBytes: 500 com JSON-aware passthrough (`^[{["]`)
  // TODO(PR-4): preserveOnError: true (skip filtro em exit ≠ 0)
}
```

### Bloqueios

PR-4 requer dois recursos novos no framework de `FilterSpec` que **não existem hoje**:

1. **`maxBytes`** (corte por bytes com UTF-8 boundary check) — distinto de `maxLines`/`truncateLineAt`.
2. **`matchOutput.passthroughIf`** ou equivalente — detecção de JSON na primeira linha não-vazia para abortar o truncamento.
3. (Opcional) **`preserveOnError`** — sinal do BashTool sobre exit code passado ao filtro.

Antes de implementar `curlBody`, abrir RFC no framework para essas extensões. Sem isso, mergear apenas a parte de progress-bar stripping (subset seguro, ~12 LOC) e marcar o restante como follow-up.

### Roadmap

- **Curto prazo (junto com PR-1..3):** estender `curlV` com progress-bar stripping em modo não-verbose. Subset seguro, sem mexer em body. ~12 LOC.
- **Médio prazo (após PRs 1-3 mergeados):** RFC do `maxBytes` + JSON-aware passthrough. Bloqueia `curlBody` completo.
- **Longo prazo:** considerar pattern de runner-style para casos onde filtro post-hoc é insuficiente (curl, wget, aws s3 cp). Decisão arquitetural; fora do escopo deste documento.

## Cuidados especiais

- **`find` tem ROI medido 0%** no uso real do Claudin (ver [`commands/find.md`](./commands/find.md) — usuários já filtram com `-not -path` e Claudin tem `GlobTool` dedicado). Não reintroduzir sem nova evidência.
- **`jq` precisa preservar JSON parseável** em modos não-pretty. `matchCommandReject` deve cobrir `-c`/`--compact-output`/`-r`/`--raw-output`/`-j`/`--join-output`/`-R`/`--raw-input`/`-s`/`--slurp`. Em modo pretty default, `truncateLineAt` corta strings — aceitável porque o modelo lê, não consome.
- **`ping`/`rsync` precisam preservar status final**. Para `ping`, manter `Request timeout` e `0 packets received`; para `rsync`, manter `rsync error:` e `Permission denied`. Em ambos, a regex `unless` (rsync) e a escolha entre `maxLines` vs `tailLines` (ping) são o ponto crítico. Os tests do RTK em [`ping.toml`](../../../../rtk/src/filters/ping.toml) e [`rsync.toml`](../../../../rtk/src/filters/rsync.toml) cobrem esses casos e devem ser portados como snapshots.
- **`ssh` sob `StrictHostKeyChecking=no` com `-v`/`-vv`/`-vvv`** gera ~30 linhas densas de banner antes do output útil. Confirmar que `^debug\d+:` (não apenas `^debug1:` como no TOML do RTK) cobre os três níveis.
- **`env` é problema de privacy, não de tokens.** Mascarar secrets aqui mudaria o contrato (usuário pediu `env`, recebe mascarado). Decisão correta: filtro de output passa, mas abrir issue para um secret-masker cross-tool.
- **`dmesg` empirical:** antes de mergear, capturar amostras de `dmesg` em laptop com uptime alto + servidor; decidir entre `maxLines` (head, primeiro boot) vs `tailLines` (eventos recentes). A versão proposta usa `tailLines=100` como hipótese.

## Padrão de teste

Seguir [`.claudin/rules/testing.md`](../../../../.claudin/rules/testing.md):

- Spec test colocada: `src/tools/shared/outputFilter/Bash/filters/system.test.ts` (cobre `tree`, `df`, `du`, `stat`, `ping`, `rsync`, `ssh`, `dmesg`) e `system.test.ts` deve crescer com cada port.
- Para `jq` considerar arquivo próprio `jq.test.ts` por causa do `matchCommandReject` extenso.
- Padrão Arrange/Act/Assert com `toMatchSnapshot()` para outputs filtrados; assertions diretas para `matchCommandReject` (caminho de passthrough).
- Cada caso de teste do TOML RTK ([`ping.toml`](../../../../rtk/src/filters/ping.toml), [`rsync.toml`](../../../../rtk/src/filters/rsync.toml), [`stat.toml`](../../../../rtk/src/filters/stat.toml) etc.) vira um `test()` no Bun.
- Validar fallback: spec inválida não deve quebrar o pipeline — garantir via teste que `filterOutput()` retorna raw em caso de erro interno (ver [`typescript-patterns.md`](../../../../.claudin/rules/typescript-patterns.md#fallback-pattern-mandatory-for-tools-that-wrap-external-commands)).

Execução focada:

```bash
bun test src/tools/shared/outputFilter/Bash/filters/system.test.ts
```

Sweep completo antes da PR:

```bash
bun run build
bun run smoke
bun test src/tools/shared/outputFilter/Bash/
bun run typecheck
```
