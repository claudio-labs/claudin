# Command: ls

**Match pattern:** `^ls(\s|$)`
**Família:** fs
**Tier:** 1
**Estratégia provável:** **native parser** (declarative não cobre o caso bem)
**Status:** analyzed
**Estimated reduction:** ~80% no `ls -la` (rtk tabela)

---

## Saída crua representativa

### Amostra 1 — `ls` simples (~80 bytes)

```
docs  package.json  README.md  scripts  src
```

Já é compacto — passthrough.

### Amostra 2 — `ls -la` (~600 bytes)

```
total 48
drwxr-xr-x  10 user  staff   320 Apr 28 14:22 .
drwxr-xr-x   8 user  staff   256 Apr 28 14:00 ..
-rw-r--r--   1 user  staff  1234 Apr 28 14:22 .gitignore
drwxr-xr-x   5 user  staff   160 Apr 28 14:22 docs
-rw-r--r--   1 user  staff  2345 Apr 28 14:22 package.json
-rw-r--r--   1 user  staff  4567 Apr 28 14:22 README.md
drwxr-xr-x   3 user  staff    96 Apr 28 14:22 scripts
drwxr-xr-x  12 user  staff   384 Apr 28 14:22 src
```

### Amostra 3 — `ls -la` em diretório grande (~3-8KB)

Não capturado. Diretórios como `node_modules/` com 200+ entries facilmente passam de 10KB.

---

## Sinal vs ruído

**Sinal (manter):**
- Nome do arquivo/diretório
- Tipo (dir vs file vs symlink)
- Tamanho (relevante pra decidir se vale `cat` ou tem que `head`)

**Ruído (remover):**
- Permissões `drwxr-xr-x` — modelo raramente decide com base nelas
- Owner / group (`user staff`) — não acionável
- Número de hardlinks (`1`, `10`) — irrelevante 99% do tempo
- Timestamp (`Apr 28 14:22`) — varia entre rodadas, **mata cache de prompt**
- Linha `total N`
- Entries `.` e `..`

**Ambíguo:**
- Diretórios "noise" típicos: `.git/`, `node_modules/`, `target/`, `dist/`, `__pycache__/` — esconder por padrão e mostrar só com `-a`?

---

## Estratégia proposta

### Pipeline declarativo NÃO funciona bem aqui

Pra reformatar `drwxr-xr-x  10 user  staff   320 Apr 28 14:22 dirname` em `dirname/` precisamos parsear colunas, e o regex fica frágil (owners com espaço, locales diferentes, símbolos `@` de xattrs no macOS, `+` de ACLs, etc.). rtk teve que fazer regex sofisticada (`LS_DATE_RE`) pra usar a data como âncora — e ainda tem casos em `ls.rs` linha 425 com `utilisa. du domaine` (grupo com espaço em locale francês).

### Native parser (recomendado)

Esboço inspirado em `rtk/src/cmds/system/ls.rs`:

```ts
// pseudocódigo
function compactLs(raw: string, opts: { showAll: boolean }): string {
  const lines = raw.split('\n')
  const dirs: string[] = []
  const files: Array<{ name: string; size: string }> = []
  const byExt = new Map<string, number>()

  for (const line of lines) {
    if (line.startsWith('total ') || !line.trim()) continue
    const parsed = parseLsLine(line)  // usa regex de data como âncora
    if (!parsed) continue
    const { fileType, size, name } = parsed

    if (name === '.' || name === '..') continue
    if (!opts.showAll && NOISE_DIRS.has(name)) continue

    if (fileType === 'd') {
      dirs.push(name)
    } else {
      files.push({ name, size: humanSize(size) })
      const ext = path.extname(name) || '(no ext)'
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1)
    }
  }

  // Output compacto: dirs primeiro com /, depois files com tamanho
  const lines = [
    ...dirs.map(d => `${d}/`),
    ...files.map(f => `${f.name}  ${f.size}`),
  ]
  // Sumário (interactive only): "5 files, 3 dirs (3 .ts, 2 .json)"
  return lines.join('\n')
}

const NOISE_DIRS = new Set([
  'node_modules', '.git', '.next', 'target', 'dist', 'build',
  '__pycache__', '.venv', 'venv', '.cache', '.idea', '.vscode',
])
```

**Saída esperada da Amostra 2:**

```
docs/
scripts/
src/
.gitignore  1.2K
package.json  2.3K
README.md  4.5K
```

~140 bytes vs 600 bytes → **~77% de redução**, alinhado com a tabela rtk.

**Justificativa pra escolher native:**
- Pipeline declarativo precisa regex sensível a locale e formato de data
- Reformatação (drwxr → `/`) não é expressável em regex sem hack
- rtk implementou native (`ls.rs` 471 linhas) e tem 80%+ redução
- Vamos usar como template — maior arquivo do feature, mas isolado e testável

### Variações do `ls` a tratar

| Comando | Estratégia |
|---|---|
| `ls` (sem flags) | passthrough (já compacto) |
| `ls -l` / `ls -la` / `ls -alh` | native parse |
| `ls -1` | passthrough (1 nome por linha, já compacto) |
| `ls --color=...` | `stripAnsi` antes de parsear |
| `ls /caminho/explicito/` | parse normalmente, prefixar header com path |
| `ls dir1 dir2` (multi-arg) | rtk fez, requer header por dir — adiar pra v2 |

---

## Edge cases / NÃO filtrar quando

- [x] `is_error: true` → passthrough (ex: `ls /naoexiste`)
- [x] Output já compacto (`ls`, `ls -1`) → detectar e passthrough
- [ ] **Locale ≠ en** — data muda (`Mar 31` em en, `mar. 31` em fr). Regex de data precisa cobrir variações ou degradar pra passthrough quando não casa.
- [ ] **macOS xattrs** — `drwxr-xr-x@` (com `@`). Parse precisa aceitar.
- [ ] **ACLs** — `drwxr-xr-x+` (com `+`). Mesmo.
- [ ] **Symlinks** — `lrwxr-xr-x ... link -> target`. Manter ` -> target`.
- [ ] **Nomes com newline** — extremamente raro mas possível. `ls -b` escapa, sem `-b` pode quebrar. Aceitável: melhor esforço.
- [ ] **`-h` (human) já aplicado** — output tem `1.2K` nativo. Detectar e não rodar `humanSize` de novo.
- [ ] **`-S` ordenado por tamanho** — preservar ordem.
- [ ] **`-r` reverso** — preservar ordem.
- [ ] **`-t` ordenado por tempo** — relevante pro user, mas removemos timestamp. Conflito? Talvez manter tempo no formato relativo (`2d ago`). Decisão: na v1 ignorar `-t`, manter ordem alfabética. Documentar limitação.

---

## Estimativa de redução

Validado empiricamente no claudin repo (5 May 2026):

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| `ls` simples (REAL) | **267** | 267 (passthrough) | 0% |
| `ls -la` (REAL: 28 entries) | **1.985** | ~250 | **~87%** |
| `ls -la` grande (200 entries) | ~12.000 (estimado) | ~3.000 (estimado) | ~75% |

**Validação:** rtk reporta 80% — nossa medição em projeto real (28 entries) deu **87%**, melhor que o reportado. ROI confirmado, alinhado.

---

## Open questions

- [ ] Manter sumário `5 files, 3 dirs (3 .ts, 2 .json)` no final? rtk faz só em TTY (`is_terminal()`). Pra LLM input, talvez queremos sempre — ajuda o modelo a saber se houve truncate.
- [ ] `NOISE_DIRS` deve ser configurável pelo user? Provavelmente sim na v2 (alguém pode estar trabalhando em monorepo onde `dist/` é relevante).
- [ ] `ls -R` (recursive) — output tem header `./subdir:` antes de cada lista. Tratar separado ou cair em passthrough se detectar?
- [ ] Quebrar simlinks circulares no parse? Provavelmente não, melhor esforço.

---

## Comparativo com rtk

- Filtro rtk: `rtk/src/cmds/system/ls.rs` (471 linhas, 13 testes)
- **O que copiamos:** abordagem geral (parse → categorize → reformat), regex de data como âncora, `NOISE_DIRS` set, sumário por extensão.
- **O que mudamos:**
  - rtk força `ls -la` por trás (mesmo se user pediu `ls`); nós só ativamos quando user pede com `-l` ou variantes.
  - rtk omite sumário em pipe (não-TTY); claudin sempre vai pra LLM, então sempre mostrar sumário.
- **Adaptações pra TS/Node:** sem `lazy_static`, criar regex como module-level `const` (regra do projeto, `.claudin/rules/typescript-patterns.md`).
