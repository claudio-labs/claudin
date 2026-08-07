# Command: docker logs

**Match pattern:** `^docker(\s+-[^\s]+)*\s+logs\b`
**Família:** docker
**Tier:** 1.5
**Estratégia provável:** declarative (strip timestamps redundantes + cap)
**Status:** analyzed (real data)
**Estimated reduction:** **~30-50%**

---

## Saída crua representativa (REAL: 4.979 bytes / 50 tail lines de postgres)

```
2026-05-05 14:35:40.337 UTC [27] LOG:  checkpoint starting: shutdown immediate
2026-05-05 14:35:40.402 UTC [27] LOG:  checkpoint complete: wrote 0 buffers (0.0%); 0 WAL file(s) added, 0 removed, 0 recycled; write=0.001 s, sync=0.001 s, total=0.085 s; sync files=0, longest=0.000 s, average=0.000 s; distance=0 kB, estimate=0 kB; lsn=0/74E73348, redo lsn=0/74E73348
2026-05-05 14:35:40.405 UTC [1] LOG:  database system is shut down

PostgreSQL Database directory appears to contain a database; Skipping initialization

2026-05-05 14:36:45.091 UTC [1] LOG:  starting PostgreSQL 16.13 on x86_64-pc-linux-musl
... (mais linhas com timestamp + PID + LOG: prefixos)
```

---

## Sinal vs ruído

**Sinal:**
- Mensagem do log (após `LOG:`, `ERROR:`, `WARN:` etc)
- Erros + tracebacks completos

**Ruído:**
- **Timestamp absoluto `2026-05-05 14:35:40.337 UTC`** — varia entre runs, mata cache. Pode virar relativo (`14:35:40` curto) ou removido se monotonic.
- **PID `[27]`, `[1]`** — em geral irrelevante (single-container, todos do mesmo processo principal)
- **Severity prefixes (`LOG:`, `WARN:`)** — manter

---

## Estratégia proposta

```jsonc
{
  "name": "docker-logs",
  "matchCommand": "^docker(\\s+-[^\\s]+)*\\s+logs\\b",
  "matchCommandReject": "-f\\b|--follow|--timestamps=false",
  "stripAnsi": true,
  "replace": [
    { "pattern": "^\\d{4}-\\d{2}-\\d{2}\\s+(\\d{2}:\\d{2}:\\d{2})\\.\\d+\\s+UTC\\s+\\[\\d+\\]\\s+", "replacement": "$1 " },
    { "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d+Z\\s+", "replacement": "" }
  ],
  "maxLines": 200
}
```

Saída esperada (~3.000 bytes em vez de 4.979 → ~40% redução):

```
14:35:40 LOG:  checkpoint starting: shutdown immediate
14:35:40 LOG:  checkpoint complete: ...
14:35:40 LOG:  database system is shut down
...
```

---

## Edge cases

- [x] `-f` / `--follow` → streaming, fora de escopo
- [x] `--timestamps=false` → user já desligou, passthrough
- [x] `is_error: true` → passthrough
- [ ] **JSON logs estruturados** (apps modernas) — formato diferente, regex não casa, degrada graceful
- [ ] **Multi-container logs** (`docker compose logs`) — prefix de service por linha, manter (filter separado seria ideal)
- [ ] **Stack traces multilinhas** — preservar; nosso regex line-by-line não corta
- [ ] **Logs em outras timezones** (não UTC) — adicionar regex variante

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **Postgres 50 tail lines (REAL)** | **4.979** | ~3.000 | **~40%** |
| App com logs JSON estruturados | ~10.000 | ~10.000 (passthrough) | 0% |
| Logs com stack traces | ~20.000 | ~12.000 | ~40% |

---

## Comparativo com rtk

- rtk: `cmds/cloud/container.rs::docker_logs` — implementa nativo (não inspecionei detalhes).
- **Frequência alta esperada** em workflow de debug.

---

## Findings empíricos

1. **40% timestamp + PID prefix** ocupa ~40% das linhas em log típico.
2. **JSON logs** invalidam o filter — degrada pra passthrough naturalmente.
3. **Tier 1.5 confirmado** — alta frequência em debug.
