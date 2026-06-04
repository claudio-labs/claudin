# Command: ps aux / ps -ef

**Match pattern:** `^ps(\s|$)`
**Família:** system
**Tier:** 1.5 (validar — pode subir, dependendo de quanto agentes inspecionam processos)
**Estratégia provável:** declarative (truncate command + strip kthreads)
**Status:** analyzed
**Estimated reduction:** **~70-85%** (medido em sistema real)

---

## Saída crua representativa (sistema linux desktop, 5 May 2026)

### Amostra 1 — `ps aux` (REAL: **90.860 bytes / 442 processos**)

```
USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
root           1  0.0  0.0  25820 14748 ?        Ss   12:23   0:01 /sbin/init
root           2  0.0  0.0      0     0 ?        S    12:23   0:00 [kthreadd]
root           3  0.0  0.0      0     0 ?        I<   12:23   0:00 [rcu_gp]
root           4  0.0  0.0      0     0 ?        I<   12:23   0:00 [rcu_par_gp]
... (~440 mais)
viudes  1234567  2.3  1.5  543210 234567 pts/3   Sl+  14:22   0:01 node /home/viudes/projects/claudin/dist/cli.mjs --some-very-long-arg=value-that-keeps-going /path/to/some/file.ts ...
```

### Amostra 2 — `ps -ef` (estimado, similar com colunas diferentes)

Não capturado, formato similar.

### Amostra 3 — `ps aux | grep node` (filter dado pelo user)

User já filtrou — output curto, passthrough.

---

## Sinal vs ruído

**Sinal (manter):**
- USER, PID, COMMAND — identificadores essenciais
- %CPU, %MEM, RSS — métricas de health
- STAT (R, S, Z, D, etc.) — estado relevante quando debug
- COMMAND completo (ou pelo menos primeiros ~80 chars)

**Ruído alto:**
- **Kernel threads** (`[kthreadd]`, `[rcu_gp]`, `[ksoftirqd]`, etc.) — `>50%` das linhas em sistema linux. Quase nunca acionável pelo agente. Strip por default.
- **VSZ** (virtual size) — métrica obsoleta, raramente útil
- **TTY** — só relevante em contextos específicos
- **START** — timestamp absoluto, varia entre rodadas, mata cache
- **TIME** (CPU time) — relevante mas formato `0:00` é noise quando todos zero

**Ambíguo:**
- COMMAND com path absoluto — `/home/viudes/projects/claudin/dist/cli.mjs ...` (60+ chars), pode truncar?

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "ps",
  "matchCommand": "^ps(\\s|$)",
  "matchCommandReject": "--format|-o\\s|--no-headers",
  "stripLinesMatching": [
    "\\s\\[[^\\]]+\\]\\s*$"
  ],
  "replace": [
    { "pattern": "^(\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+)\\S+\\s+(\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+)", "replacement": "$1$2" }
  ],
  "truncateLineAt": 200,
  "maxLines": 50
}
```

**Notas:**
- `stripLinesMatching` com pattern `\s\[[^\]]+\]\s*$` casa kernel threads (COMMAND entre `[]`)
- `replace` remove coluna VSZ (5ª coluna)
- `truncateLineAt: 200` evita linhas absurdas com argumentos longos
- `maxLines: 50` cap absoluto — rara situação que precise mais

### Estratégia native (v2)

Parser que reformata em estilo `top -bn1` mais compacto, ordenado por %CPU desc:

```
PID    USER     %CPU  %MEM  COMMAND
1234   viudes   23.4   8.5  node /path/to/cli.mjs
567    viudes   12.1   3.2  bun run dev
89     viudes    5.6   1.8  Code
... (top 20 por %CPU + count "+422 idle")
```

Agressivo, ~95% redução. Adiciona parser TS. Adiar pra v2.

---

## Edge cases / NÃO filtrar quando

- [x] `ps aux | grep X` (user filtrou) — passthrough (ou filter mas com `maxLines: 50` generoso)
- [x] `--format` / `-o` custom — passthrough (user escolheu colunas)
- [x] `--no-headers` — user já reduziu
- [x] `is_error: true` — passthrough (`ps` raramente falha; se falhou, info importante)
- [ ] **Hostnames diferentes** — não afeta `ps` (diferente de `journalctl`)
- [ ] **Container/cgroup awareness** — `ps aux` em container só vê processos do namespace, output muito menor
- [ ] **macOS `ps`** — colunas diferentes (`ps aux` no Mac mostra `STARTED` em vez de `START`); regex precisa cobrir ou degradar pra passthrough

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **`ps aux` sistema real (442 procs)** | **90.860** | ~12.000 (50 linhas × ~240 chars) | **~87%** |
| `ps aux` em container (50 procs) | ~10.000 | ~5.000 | ~50% |
| `ps aux | grep node` (3 linhas) | ~600 | ~600 (passthrough ou minimal cut) | 0-10% |

**Achado:** `maxLines: 50` é o que dá o ganho — outros 392 processos viram noise puro. Se o agente precisa ver TODOS, deveria usar `ps aux | grep ...` ou outras flags. Padrão `ps aux` cego é caso de "agente errou de comando" mais que "info útil".

---

## Open questions

- [ ] **`maxLines: 50` é demais ou de menos?** Em servidor com 200 services rodando, 50 pode cortar info útil. Mas em desktop com 442 processos (kernel + user), 50 já é generoso.
- [ ] **Strip de kernel threads é seguro?** Casos onde matter: debug de performance kernel-level (mas aí user usa `top -H` ou ferramentas específicas).
- [ ] **`ps -eLf` (threads)** — output muito maior, comportamento diferente. Caso edge.
- [ ] **`ps -o pid,cmd`** custom format — passthrough seguro.

---

## Comparativo com rtk

- rtk: `filters/ps.toml` (declarativo)
  ```toml
  match_command = "^ps(\\s|$)"
  truncate_lines_at = 120
  max_lines = 30
  ```
- rtk é **mais agressivo no truncate** (120 vs nosso 200) e **mais agressivo no maxLines** (30 vs 50).
- **O que copiamos:** approach declarativo total.
- **O que mudamos:** adicionamos `stripLinesMatching` pra kernel threads — rtk não tem, perde info válida em sistemas linux full-host.

---

## Findings empíricos

1. **Sistemas linux desktop typicamente têm 400-500 processos**, sendo **~50% kernel threads** — alvo enorme de strip.
2. **`ps aux` cego é geralmente erro de uso** — agentes deveriam usar grep/filter no ps.
3. **Volume é real:** 90KB de uma chamada de `ps aux` justifica filtro mesmo se o agente não usar muito.
