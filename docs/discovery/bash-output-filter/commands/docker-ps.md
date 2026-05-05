# Command: docker ps

**Match pattern:** `^docker(\s+-[^\s]+)*\s+ps\b`
**Família:** docker
**Tier:** 1
**Estratégia provável:** declarative pipeline (column truncate + replace)
**Status:** analyzed
**Estimated reduction:** ~80% (rtk tabela)

---

## Saída crua representativa

### Amostra 1 — `docker ps` sem containers (~50 bytes)

```
CONTAINER ID   IMAGE     COMMAND   CREATED   STATUS    PORTS     NAMES
```

Passthrough (já mínimo).

### Amostra 2 — `docker ps` com 3 containers (~600 bytes)

```
CONTAINER ID   IMAGE                          COMMAND                  CREATED        STATUS                  PORTS                                       NAMES
a3f8c9d2e1b7   postgres:16-alpine             "docker-entrypoint.s…"   2 hours ago    Up 2 hours              0.0.0.0:5432->5432/tcp                      claudio-db
9b8c7d6e5f4a   redis:7-alpine                 "docker-entrypoint.s…"   2 hours ago    Up 2 hours              0.0.0.0:6379->6379/tcp                      claudio-cache
1e2f3a4b5c6d   ghcr.io/anthropics/foo:v1.2.3  "/usr/local/bin/foo …"   3 days ago     Up 2 hours (healthy)    0.0.0.0:8080->8080/tcp, 0.0.0.0:9090/tcp   claudio-api
```

### Amostra 3 — `docker ps -a` com 20+ containers (~3-6KB)

Não capturado. Em CI/dev típico facilmente passa de 5KB.

---

## Sinal vs ruído

**Sinal (manter):**
- Nome do container (`NAMES`) — chave operacional
- Imagem (`IMAGE`) — saber o que está rodando
- Status (`STATUS`) — `Up`, `Exited (1)`, `Restarting`, `(healthy)`, `(unhealthy)`
- Portas mapeadas (`PORTS`) — `0.0.0.0:5432->5432/tcp` é acionável

**Ruído (remover):**
- `CONTAINER ID` (12 chars de hash) — só serve se modelo for fazer `docker exec <id>`, mas pode usar nome (`docker exec <name>`). Removível.
- `COMMAND` (`"docker-entrypoint.s…"`) — quase sempre truncado e redundante com IMAGE
- `CREATED` (`2 hours ago`) — varia entre rodadas, **mata cache de prompt**
- Coluna `IMAGE` com prefixo de registry (`ghcr.io/anthropics/foo:v1.2.3` → talvez só `foo:v1.2.3`)

**Ambíguo:**
- Manter `(healthy)` / `(unhealthy)` no STATUS — sim, sinal forte
- Cache de imagem completo vs short — depende de uso

---

## Estratégia proposta

### Pipeline declarativo

```jsonc
{
  "name": "docker-ps",
  "matchCommand": "^docker(\\s+-[^\\s]+)*\\s+ps\\b",
  "matchCommandReject": "--format|--quiet|-q\\b|--no-trunc",
  "stripAnsi": true,
  "replace": [
    // Remover coluna CONTAINER ID (12 chars hex + spaces)
    { "pattern": "^[0-9a-f]{12}\\s+", "replacement": "" },
    // Remover header CONTAINER ID
    { "pattern": "^CONTAINER ID\\s+", "replacement": "" },
    // Truncar COMMAND (já vem com … nativo, mas ainda ocupa)
    { "pattern": "\"[^\"]{1,40}…\"", "replacement": "\"…\"" },
    // CREATED → remover ("X hours ago", "X days ago", etc.)
    { "pattern": "\\s+\\d+\\s+(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\\s+ago\\b", "replacement": "" }
  ],
  "truncateLineAt": 200,
  "onEmpty": "No matching containers."
}
```

**Saída esperada da Amostra 2:**

```
IMAGE                          COMMAND   STATUS                  PORTS                                       NAMES
postgres:16-alpine             "…"       Up 2 hours              0.0.0.0:5432->5432/tcp                      claudio-db
redis:7-alpine                 "…"       Up 2 hours              0.0.0.0:6379->6379/tcp                      claudio-cache
ghcr.io/anthropics/foo:v1.2.3  "…"       Up 2 hours (healthy)    0.0.0.0:8080->8080/tcp, 0.0.0.0:9090/tcp   claudio-api
```

~430 bytes vs 600 → ~28% de redução. **Aquém da meta de 80%**. Por quê?

A maior parte do output útil são strings que precisamos manter (nomes longos, port mappings). O CREATED column é o maior ganho mas é só ~15% do tamanho.

### Estratégia mais agressiva: forçar `--format`

Substituir o comando do user por:

```bash
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
```

Saída:
```
NAMES            IMAGE                          STATUS                  PORTS
claudio-db       postgres:16-alpine             Up 2 hours              0.0.0.0:5432->5432/tcp
claudio-cache    redis:7-alpine                 Up 2 hours              0.0.0.0:6379->6379/tcp
claudio-api      ghcr.io/anthropics/foo:v1.2.3  Up 2 hours (healthy)    0.0.0.0:8080->8080/tcp, ...
```

~280 bytes vs 600 → **~53% de redução**. Mais limpo, mais determinístico.

**Tradeoff:** quebrar princípio "preserve user intent". Mas é tão padrão que provavelmente OK.

**Recomendação:** aplicar Opção A (declarative) na v1 conservadoramente; avaliar se vale a Opção B (rewrite com --format) na v2 quando tivermos dados de uso.

---

## Edge cases / NÃO filtrar quando

- [x] `is_error: true` → passthrough (docker daemon down, etc.)
- [x] `--format <custom>` → passthrough (user já especificou formato)
- [x] `--quiet` / `-q` → passthrough (só IDs, já mínimo)
- [x] `--no-trunc` → passthrough (user pediu colunas inteiras)
- [ ] **`docker ps -a`** (mostra parados também) — mesma estratégia, só mais linhas; respeitar `maxLines: 50`?
- [ ] **`docker ps --filter ...`** — filtro do user já reduz output; aplicar nosso filtro depois OK
- [ ] **JSON output via `--format json`** — passthrough, é estruturado
- [ ] **Container ID na coluna NAMES** (raro mas possível com `--format`) — não tratar
- [ ] **Output ANSI colorido** (se TTY) — `stripAnsi` na v1

---

## Estimativa de redução

Validado empiricamente (5 May 2026, ambiente real com 6 containers — 2 running healthy, 4 exited):

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| 0 containers | 50 | 50 (passthrough) | 0% |
| **6 containers (REAL: 2 running + 4 exited)** | **1.195** | ~840 (Opção A) / ~600 (Opção B) | **~30%** / **~50%** |
| 20 containers | ~5.000 | ~3.500 / ~2.300 | 30% / 54% |

**Detalhe da amostra real:** dual binding IPv4+IPv6 dobra o PORTS column (`0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp`). Adicionar regra pra colapsar IPv6 redundante:

```jsonc
{ "pattern": ", \\[::\\]:\\d+->\\d+/(?:tcp|udp)", "replacement": "" }
```

Isso adiciona ~5% de redução na amostra real.

**Achado importante:** o ROI do `docker ps` é menor do que rtk sugere (rtk: 80% — nós: 30%). A linha de header e nomes de containers/imagens são incompressíveis. **Confirmado — rebaixar pra Tier 2** após Fase 0.

---

## Open questions

- [ ] Adotar Opção B (rewrite com `--format`) já na v1 ou esperar v2?
- [ ] Adicionar `maxLines: 50` pra `docker ps -a` em CI com 200 containers parados?
- [ ] Tratar `docker container ls` (alias) — mesmo filtro deve aplicar
- [ ] `docker compose ps` — formato similar mas com coluna `SERVICE` extra. Filtro separado.
- [ ] Outros docker commands (`docker images`, `docker logs`, `docker inspect`) — arquivos separados quando estudarmos

---

## Comparativo com rtk

- rtk tem filtro nativo em `cmds/system/`? Não confirmei — `RUST_HANDLED_COMMANDS` em `toml_filter.rs:281` lista `"docker"`, então sim. Verificar implementação.
- **O que copiamos:** ideia de remover CONTAINER ID e CREATED.
- **O que mudamos:** rtk pode fazer parsing nativo; preferimos declarativo aqui porque o ganho é modesto e não justifica novo módulo TS.
- **Crítica honesta:** rtk reporta 80% nessa linha da tabela. Nossa análise sugere 30-50%. Possível que a tabela do rtk seja sobre `docker ps -a` em ambiente com muitos containers stopped — context matters.
