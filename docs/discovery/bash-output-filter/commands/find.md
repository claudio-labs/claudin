# Command: find

**Match pattern:** `^find(\s|$)`
**Família:** fs
**Tier:** 2 (rebaixado após análise — ver findings)
**Estratégia provável:** declarative (head cap + dedup permission denied)
**Status:** analyzed
**Estimated reduction:** **~0-30%** dependendo do uso (medido baixo em projetos reais)

---

## Saída crua representativa (claudin repo)

### Amostra 1 — `find . -maxdepth 2 -type f -not -path "./node_modules/*" -not -path "./.git/*" -not -path "./dist/*"` (107 paths, ~3KB)

```
./.dockerignore
./.env.example
./.gitignore
./.release-please-manifest.json
./ANDROID_INSTALL.md
./CONTRIBUTING.md
./Dockerfile
./LICENSE
./PLAYBOOK.md
./bun.lock
./tsconfig.json
./CODE_OF_CONDUCT.md
./CHANGELOG.md
./README.md
./SECURITY.md
./release-please-config.json
./ROADMAP.md
./CLAUDE.md
./package.json
./.github/pull_request_template.md
./bin/claudin
./docs/hook-chains.md
./docs/litellm-setup.md
...
```

User já filtrou os diretórios noise. Output é **puro sinal**.

### Amostra 2 — `find . -type f` sem filtro (não capturado, estimado >50.000 paths em monorepo com node_modules)

Aí sim a maioria seria noise (`./node_modules/.../{index.js,package.json,LICENSE,*.d.ts}`).

### Amostra 3 — `find` com permission errors (não capturado)

Tipicamente:
```
./real/path/file.txt
find: './restricted': Permission denied
./other/path.txt
find: './otherrestricted': Permission denied
...
```

---

## Sinal vs ruído

**Sinal (manter):**
- Caminhos encontrados — esse é o output todo

**Ruído (potencial):**
- `find: '/path': Permission denied` — útil saber que aconteceu, mas dedupliar para 1-2 ocorrências + contagem
- Resultados em diretórios "noise" se user esqueceu de filtrar (`node_modules/`, `.git/`, `target/`)

**Ambíguo:**
- Truncar paths longos? Não, paths são coordenadas — truncar quebra utilidade
- Agrupar `./src/components/Foo/{file1,file2,file3}` em prefixo comum? Adiciona complexidade, ganho marginal

---

## Estratégia proposta

### Pipeline declarativo enxuto

```jsonc
{
  "name": "find",
  "matchCommand": "^find(\\s|$)",
  "matchCommandReject": "-print0|-exec\\b|-printf",
  "stripLinesMatching": [
    "^find: '.*': Permission denied$"
  ],
  "matchOutput": [
    {
      "pattern": "find: .* Permission denied",
      "message": "[find: N permission errors suppressed]\n",
      "unless": "^[a-zA-Z./]"
    }
  ],
  "maxLines": 500
}
```

**`maxLines: 500`** é generoso porque paths são informação real. Mais agressivo seria preocupante.

### Estratégia "agrupamento por prefixo"

Se output > 100 linhas, agrupar:

```
./src/components/Foo/* (47 files)
./src/components/Bar/* (23 files)
./tests/unit/* (89 files)
```

**Tradeoff:** quebra capacidade do modelo de pegar 1 arquivo específico pra `cat`. Não recomendado na v1.

---

## Edge cases / NÃO filtrar quando

- [x] `-print0` (NUL-separated) → passthrough (binário)
- [x] `-exec ... \;` → output do comando exec, não compactável genericamente
- [x] `-printf` (formato custom) → passthrough (user escolheu formato)
- [x] `-quit` → output curto
- [x] `is_error: true` → passthrough
- [ ] **`-name "*.something"` já reduz** → filtro não tem o que cortar
- [ ] **`find / -name X`** (busca global lenta) — output pode ter Permission denied massivos. Dedup faz sentido.
- [ ] **Output com paths contendo newlines** (raro) — quebra contagem de linhas. Aceitar.
- [ ] **`find ... | xargs ...`** — pipe, nosso filtro só vê output final do pipe (ou só `find` se pipe está num subshell?). Verificar como BashTool entrega.

---

## Estimativa de redução

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| 107 paths user-filtered | ~3.000 | ~3.000 (passthrough) | 0% |
| 500 paths sem `node_modules`/`.git` | ~15.000 | ~15.000 | 0% |
| 1.000+ paths sem filtro | ~50.000+ | ~16.000 (capped a 500) | 67% (mas perde info) |
| 50+ Permission denied | ~5.000 | ~200 (1 marker) | 96% (caso edge) |

**Achado:** `find` em uso real (com user já filtrando) tem **0% de ROI**. Só economiza em casos onde:
- User esqueceu filtros e percorreu `node_modules` — caso patológico
- Permissões denied em massa — caso edge

---

## Open questions

- [ ] **Mover pra Tier 2?** Análise empírica sugere que sim — usuários sofisticados já filtram, e o claudin tem `GlobTool` dedicado.
- [ ] Vale o agrupamento por prefixo? Adiciona complexidade.
- [ ] Considerar `fd` (modern find) — mesmo regex de match cobre `^fd\b`? Adicionar `^(find|fd)\b`?

---

## Comparativo com rtk

- rtk: `cmds/system/find_cmd.rs` — não inspecionei. Possivelmente tem agrupamento.
- rtk não inclui `find` na tabela de savings principal — confirma ROI baixo.

---

## Findings empíricos

1. **`find` user-filtered é puro sinal** — 0% economizável.
2. **`find` cego (sem `-not -path`)** é o único caso onde compressão importa, e isso é mau hábito do user, não algo que filtro deve "consertar" automaticamente.
3. **claudin já tem `GlobTool`** — usuários sofisticados deveriam usar isso. `find` em Bash é fallback, ROI baixo.
4. **Recomendação:** Tier 2 com prioridade baixa. v1 pode pular.
