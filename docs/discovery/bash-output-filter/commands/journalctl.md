# Command: journalctl

**Match pattern:** `^(sudo\s+)?journalctl\b`
**Família:** system
**Tier:** 1.5 (validar Fase 0 — frequência depende de uso ops/SRE)
**Estratégia provável:** declarative (strip hostname + service repetidos)
**Status:** analyzed
**Estimated reduction:** **~30-40%** (medido)

---

## Saída crua representativa (sistema linux desktop, 5 May 2026)

### Amostra 1 — `journalctl --no-pager -n 20 -u systemd-logind` (REAL: **1.879 bytes / 21 linhas**)

```
May 05 12:18:04 viudes-arch systemd-logind[726]: Watching system buttons on /dev/input/event1 (Power Button)
May 05 12:18:04 viudes-arch systemd-logind[726]: Watching system buttons on /dev/input/event4 (Logitech USB Receiver Keyboard)
May 05 12:22:44 viudes-arch systemd-logind[726]: The system will reboot now!
May 05 12:22:44 viudes-arch systemd-logind[726]: System is rebooting.
May 05 12:22:44 viudes-arch systemd-logind[726]: Session 5 logged out. Waiting for processes to exit.
May 05 12:22:44 viudes-arch systemd-logind[726]: Removed session 5.
May 05 12:22:44 viudes-arch systemd-logind[726]: Removed session 6.
May 05 12:22:44 viudes-arch systemd-logind[726]: Removed session 1.
May 05 12:22:49 viudes-arch systemd[1]: Stopping User Login Management...
May 05 12:22:49 viudes-arch systemd[1]: systemd-logind.service: Deactivated successfully.
May 05 12:22:49 viudes-arch systemd[1]: Stopped User Login Management.
-- Boot ed3041156fb04270ae0d53e7892c949b --
May 05 12:23:37 viudes-arch systemd[1]: Starting User Login Management...
May 05 12:23:37 viudes-arch systemd-logind[730]: New seat seat0.
May 05 12:23:37 viudes-arch systemd-logind[730]: Watching system buttons on /dev/input/event2 (Power Button)
... (mais linhas)
```

### Amostra 2 — sem `-u <service>` (toda jornada do sistema, GBs em sistemas long-running)

```
May 05 14:30:00 viudes-arch kernel: ...
May 05 14:30:00 viudes-arch sshd[1234]: Accepted publickey...
May 05 14:30:01 viudes-arch systemd[1]: ...
... (milhares de linhas, dezenas de services)
```

---

## Sinal vs ruído

**Sinal (manter):**
- Timestamp (relevante pra debug)
- Service name + pid (identificar quem logou) — **mas se já filtrou por `-u <service>`, vira redundante**
- Mensagem de log

**Ruído quando user já filtrou com `-u <service>`:**
- **`hostname` em todas as linhas** — `viudes-arch` repete identicamente em 100% das linhas. Strip total seguro.
- **`service[pid]:` repetido** — quando filtrado por `-u systemd-logind`, esse prefixo aparece em quase toda linha. Strip parcial.
- Boot markers `-- Boot xxxx --` — útil mas pode ser comprimido pra `[reboot]`

**Ruído sem `-u`:**
- hostname ainda redundante (1 sistema só)
- service prefix é informação real (qual service emitiu)

---

## Estratégia proposta

### Pipeline declarativo (sem `-u`)

```jsonc
{
  "name": "journalctl",
  "matchCommand": "^(sudo\\s+)?journalctl\\b",
  "matchCommandReject": "--output=json|--output=cat|-o\\s+(json|cat|export)",
  "replace": [
    { "pattern": "^(\\w{3} \\d\\d \\d\\d:\\d\\d:\\d\\d) \\S+ ", "replacement": "$1 " }
  ],
  "stripLinesMatching": [
    "^-- No entries --$"
  ]
}
```

**Saída:** remove hostname (`\S+` após timestamp). Reduz ~15%.

### Estratégia conditional (detectar `-u`)

Se comando tem `-u <service>`, ALSO strip service prefix:

```ts
// pseudocódigo — detectar flag, ajustar replaces
const hasUnitFilter = /-u\s+\S+/.test(command)
const replaces = [
  { pattern: /^(\w{3} \d\d \d\d:\d\d:\d\d) \S+ /, replacement: '$1 ' },
  ...(hasUnitFilter ? [{ pattern: /\S+\[\d+\]:\s/, replacement: '' }] : [])
]
```

Adiciona ~15% extra quando aplicável.

**Saída esperada Amostra 1 com strategy completa:**

```
May 05 12:18:04 Watching system buttons on /dev/input/event1 (Power Button)
May 05 12:18:04 Watching system buttons on /dev/input/event4 (Logitech USB Receiver Keyboard)
May 05 12:22:44 The system will reboot now!
May 05 12:22:44 System is rebooting.
May 05 12:22:44 Session 5 logged out. Waiting for processes to exit.
May 05 12:22:44 Removed session 5.
May 05 12:22:44 Removed session 6.
May 05 12:22:44 Removed session 1.
May 05 12:22:49 Stopping User Login Management...
May 05 12:22:49 systemd-logind.service: Deactivated successfully.
May 05 12:22:49 Stopped User Login Management.
[reboot]
May 05 12:23:37 Starting User Login Management...
...
```

~1.100 bytes vs 1.879 bytes → **~41% redução**.

### Estratégia agressiva: timestamp relativo

Substituir `May 05 12:18:04` por `12:18:04` se todas as entradas são do mesmo dia:

**Adicional:** ~10%. **Adiar pra v2.**

---

## Edge cases / NÃO filtrar quando

- [x] `--output=json` / `-o json` — passthrough (estruturado)
- [x] `--output=cat` / `-o cat` — só mensagem, passthrough (já compacto)
- [x] `-f` (follow) — streaming, fora de escopo
- [x] `is_error: true` — passthrough
- [ ] **`-r` (reverse)** — comportamento idêntico, strip funciona
- [ ] **Multi-host (`journalctl --machine=...`)** — hostname matters! Não strip se `--machine` está presente.
- [ ] **Saída com prefixos especiais** (`-- Reboot --`, `-- No entries --`) — preservar como markers de transição
- [ ] **Mensagens multilinha** (com newline embutido) — preservar; nosso regex line-by-line não afeta

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **`-u systemd-logind -n 20` (REAL)** | **1.879** | ~1.100 | **~41%** |
| Sem `-u`, 100 linhas | ~10.000 | ~8.500 (só hostname) | ~15% |
| Com `-u service`, 1000 linhas | ~120.000 | ~70.000 | ~42% |

---

## Open questions

- [ ] Quão útil é o boot marker `-- Boot xxxx --` pra LLM? Provavelmente "houve reboot, info acima é de antes" é tudo que importa. Comprimir pra `[reboot]` seguro.
- [ ] Como detectar `--machine` corretamente sem parser de bash completo?
- [ ] **Frequência de uso real?** Agente típico no claudin mexe com web/CLI dev, raramente com systemd. Tier 1.5 ou 2?

---

## Comparativo com rtk

- rtk: não vi `journalctl` na lista de filtros nem em `cmds/`. Provavelmente não cobre.
- **Possível win exclusivo do claudin** — usuários de SRE/ops podem ganhar muito.

---

## Findings empíricos

1. **Hostname duplica em 100% das linhas** — strip seguro ~15%.
2. **Quando user passa `-u <service>`**, service prefix vira redundante — strip ~15% adicional.
3. **rtk não cobre journalctl** — oportunidade de feature exclusiva.
4. **Cuidado com `--machine`** — multi-host invalida o strip de hostname.
