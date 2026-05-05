# Command: docker build / docker buildx build

**Match pattern:** `^docker(\s+-[^\s]+)*\s+(build|buildx\s+build)\b`
**Família:** docker
**Tier:** 1.5
**Estratégia provável:** declarative (strip pull progress + Step N/M lines + match_output success)
**Status:** **NOT analyzed** (não capturado — sem Dockerfile testável)
**Estimated reduction:** **~70-90%**

---

## Saída crua representativa (estrutura conhecida)

⚠️ Não capturado. Estrutura típica:

### `docker build .` (BuildKit moderno)

```
[+] Building 12.3s (15/15) FINISHED
 => [internal] load build definition from Dockerfile                        0.1s
 => => transferring dockerfile: 234B                                        0.0s
 => [internal] load .dockerignore                                           0.1s
 => => transferring context: 89B                                            0.0s
 => [internal] load metadata for docker.io/library/node:20-alpine           1.2s
 => [1/8] FROM docker.io/library/node:20-alpine@sha256:abc123...            3.4s
 => => resolve docker.io/library/node:20-alpine@sha256:abc123...            0.0s
 => => sha256:abc... 7.10MB / 7.10MB                                        2.1s
 => => extracting sha256:abc...                                             1.2s
 => [2/8] WORKDIR /app                                                      0.1s
 => [3/8] COPY package.json package-lock.json ./                            0.0s
 => [4/8] RUN npm ci --omit=dev                                             6.7s
 => [5/8] COPY . .                                                          0.1s
 => [6/8] RUN npm run build                                                 0.5s
 => exporting to image                                                      0.2s
 => => exporting layers                                                     0.1s
 => => writing image sha256:def456...                                       0.0s
 => => naming to docker.io/library/myapp:latest                             0.0s
```

### Build legacy (sem BuildKit)

```
Sending build context to Docker daemon  234kB
Step 1/8 : FROM node:20-alpine
 ---> abc123def456
Step 2/8 : WORKDIR /app
 ---> Using cache
 ---> 789ghi012jkl
Step 3/8 : COPY package.json ./
 ---> 345mno678pqr
... (Step N/M por instrução)
Successfully built abc123def456
Successfully tagged myapp:latest
```

### Erro de build

```
... (steps até onde falhou) ...
Step 5/8 : RUN npm ci
ERROR: command failed: ...
The command '/bin/sh -c npm ci' returned a non-zero code: 1
```

---

## Sinal vs ruído

**Sinal:**
- `Successfully built|tagged X` ou `=> => writing image sha256:...`
- `naming to ...:tag`
- ERRORS completos
- Final `[+] Building Xs (N/M) FINISHED` ou similar

**Ruído (BuildKit):**
- `=> transferring dockerfile|context: NB`
- `=> => sha256:... NM/NM`
- `=> => resolve|extracting`
- Tempos individuais por step (varia entre runs)

**Ruído (legacy):**
- `Sending build context to Docker daemon`
- `Using cache` lines (sem progresso real)
- ` ---> hash` lines (intermediate layer hashes)

---

## Estratégia proposta

```jsonc
{
  "name": "docker-build",
  "matchCommand": "^docker(\\s+-[^\\s]+)*\\s+(build|buildx\\s+build)\\b",
  "matchCommandReject": "--progress=plain|--no-cache=true|--quiet",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^Sending build context to Docker daemon",
    "^\\s*---> Using cache$",
    "^\\s*---> [0-9a-f]{12}$",
    "^\\s*=>\\s+(?:resolve|transferring|extracting)\\s",
    "^\\s*=>\\s+sha256:[0-9a-f]+",
    "^\\s*=>\\s+=>\\s+",
    "^\\s*$"
  ],
  "matchOutput": [
    {
      "pattern": "Successfully built [0-9a-f]+|=> => naming to ",
      "message": "✓ docker build successful",
      "unless": "(?i)\\b(error|failed|cannot)\\b|returned a non-zero code"
    }
  ],
  "maxLines": 50
}
```

---

## Edge cases

- [x] `--progress=plain` → passthrough (user pediu detalhe)
- [x] `--quiet` → passthrough
- [x] `is_error: true` → preservar (errors importantes)
- [ ] **Multi-stage build** com 5+ stages — output 3-5× maior, mesmo filter
- [ ] **`docker buildx build --platform=linux/amd64,linux/arm64`** — output dobra, mesmo filter
- [ ] **Cache hit total** — output muito curto, passthrough natural
- [ ] **BuildKit spinner** (`⠋ ⠙ ⠹`) caracteres unicode — `stripAnsi` não cobre, precisa regex separada

---

## Estimativa de redução

| Cenário | Antes (est.) | Depois | Redução |
|---|---|---|---|
| Build sucesso (BuildKit, 8 steps) | ~5.000 | ~80 (`match_output`) | **98%** |
| Build com erro | ~3.000 | ~600 (preservados) | ~80% |
| Build multi-platform | ~10.000 | ~150 | **98%** |

---

## Findings empíricos

**ZERO empirical findings** — não capturado.

1. **`match_output` "successfully built"** é o win principal.
2. **BuildKit é mais verboso** que legacy mas tem padrões mais regulares pra strippar.
3. **Recomendação:** Tier 1.5 — comum em workflow de dev/CI.
