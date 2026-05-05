# Command: top -bn1 / htop

**Match pattern:** `^top\b`
**Família:** system
**Tier:** 2
**Estratégia provável:** declarative (cap em maxLines + strip header redundante)
**Status:** analyzed (real data)
**Estimated reduction:** **~70-85%** (similar a `ps aux`)

---

## Saída crua representativa (REAL: `top -bn1`, 2.288 bytes truncado head -30)

```
top - 15:24:34 up  3:01,  1 user,  load average: 0.37, 0.32, 0.37
Tasks: 453 total, 1 running, 443 sleep, 0 d-sleep, 0 stopped, 9 zombie
%Cpu(s):  1.4 us,  0.6 sy,  0.0 ni, 98.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st 
MiB Mem :  48102.1 total,  29781.7 free,  13213.0 used,   6280.4 buff/cache     
MiB Swap:      0.0 total,      0.0 free,      0.0 used.  34889.1 avail Mem 

    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND
  51369 viudes    20   0   70.9g 600116 114548 S  14.4   1.2   8:37.06 claude
      1 root      20   0   25820  14748  10296 S   0.0   0.0   0:01.21 systemd
      2 root      20   0       0      0      0 S   0.0   0.0   0:00.00 kthreadd
... (mais linhas com PID/USER/etc)
```

**Estrutura:**
- 5 linhas de header (load, tasks, cpu, mem, swap) — info útil
- Linha em branco
- Header da tabela
- N linhas de processos (uma por PID)

---

## Sinal vs ruído

**Sinal:**
- Header de load + tasks + cpu + mem (5 linhas) — diagnóstico rápido
- Top 20-30 processos por %CPU/%MEM — quem está consumindo recursos

**Ruído:**
- **Kernel threads (`[kthreadd]`, `[rcu_gp]`)** com COMMAND entre `[]` — strip seguro, igual ao `ps-aux.md`
- **Processos idle** (%CPU 0.0, %MEM 0.0) — talvez strip se top tiver muitos
- Coluna **TIME+** absoluta — varia entre runs

---

## Estratégia proposta

```jsonc
{
  "name": "top",
  "matchCommand": "^top\\b",
  "matchCommandReject": "-H\\b",
  "stripLinesMatching": [
    "\\s\\[[^\\]]+\\]\\s*$"
  ],
  "truncateLineAt": 200,
  "maxLines": 40
}
```

---

## Edge cases

- [x] `-H` (threads) → passthrough
- [x] `htop` → interativo, fora de escopo
- [ ] **`top` sem `-bn1`** — interativo, fora de escopo (não chega no BashTool)
- [ ] **`-p PID`** — só processos específicos, output curto
- [ ] **`-u user`** — só do user, ainda compactável

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **`top -bn1` 30 linhas (REAL)** | **2.288** | ~1.500 (kthreads stripped) | **~35%** |
| `top -bn1` full (200+ linhas) | ~12.000 | ~3.000 (cap 40 + strip kthreads) | ~75% |

---

## Comparativo com rtk

- rtk: não vi filter específico pra `top`. Possivelmente coberto pelo `ps` filter genericamente.

---

## Findings empíricos

1. **Header é 5 linhas** valiosas (load, tasks, cpu, mem, swap) — preservar.
2. **Strip de kernel threads** dá ~30% sozinho.
3. **`maxLines: 40`** porque header + ~35 processos é suficiente.
4. **Frequência baixa esperada** — agente típico não usa muito.
