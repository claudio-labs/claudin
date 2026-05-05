# Command: docker images

**Match pattern:** `^docker(\s+-[^\s]+)*\s+images\b`
**Família:** docker
**Tier:** 2
**Estratégia provável:** declarative (strip warning + simple column work)
**Status:** analyzed (real data)
**Estimated reduction:** **~20-40%**

---

## Saída crua representativa (REAL: 454 bytes / 3 imagens)

```
WARNING: This output is designed for human readability. For machine-readable output, please use --format.
IMAGE                                 ID             DISK USAGE   CONTENT SIZE   EXTRA
ghcr.io/ericc-ch/copilot-api:latest   1b57d0dd9897        162MB             0B   U    
postgres:16-alpine                    108b27c919e6        276MB             0B   U    
redis:7-alpine                        aa189b5a1954       41.4MB             0B   U
```

---

## Sinal vs ruído

**Sinal:** IMAGE (nome:tag), DISK USAGE, EXTRA (status flag)

**Ruído:**
- **WARNING** linha sobre `--format` — strip puro
- **ID** (12 chars hash) — referenciável mas raramente usado pra ação (geralmente usamos nome:tag)
- **CONTENT SIZE** — quase sempre `0B` em uso típico (varia se imagem foi compartilhada)

---

## Estratégia proposta

```jsonc
{
  "name": "docker-images",
  "matchCommand": "^docker(\\s+-[^\\s]+)*\\s+images\\b",
  "matchCommandReject": "--format|--quiet|-q\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^WARNING: This output is designed for human readability"
  ],
  "replace": [
    { "pattern": "\\b[0-9a-f]{12}\\s+", "replacement": "" }
  ],
  "maxLines": 50
}
```

---

## Estimativa de redução

| Cenário | Antes (bytes) | Depois | Redução |
|---|---|---|---|
| **3 images (REAL)** | **454** | ~280 | **~38%** |
| 50 images | ~7.000 | ~4.500 | ~36% |

---

## Edge cases

- [x] `--format` / `-q` → passthrough
- [ ] **Dangling images** (`<none>:<none>`) — preservar info
- [ ] **`docker image ls`** alias — filter same

---

## Findings empíricos

1. **WARNING `--format` line** é puro ruído — sempre strippar.
2. **ID column** ~13 chars/linha × N linhas = ganho modesto.
3. **Tier 2** — frequência baixa, ROI moderado.
