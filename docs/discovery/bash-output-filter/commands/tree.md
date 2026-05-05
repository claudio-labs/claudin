# Command: tree

**Match pattern:** `^tree(\s|$)`
**Família:** fs
**Tier:** 1.5
**Estratégia provável:** declarative (depth cap + dedup noise dirs)
**Status:** **NOT analyzed** (`tree` não instalado no ambiente local)
**Estimated reduction:** ~80% (rtk tabela genérica)

---

## Saída crua representativa

⚠️ `tree` não está instalado no ambiente de discovery. Estrutura típica:

### `tree -L 2`

```
.
├── docs
│   ├── advanced-setup.md
│   ├── plans
│   ├── quick-start-mac-linux.md
│   └── quick-start-windows.md
├── node_modules
│   ├── @anthropic-ai
│   ├── @types
│   ├── ... (300+ entries)
│   └── zod
├── package.json
├── scripts
│   ├── build.ts
│   └── ...
├── src
│   ├── QueryEngine.ts
│   ├── Tool.ts
│   ├── components
│   ├── tools
│   └── utils
└── README.md

15 directories, 47 files
```

### `tree` sem flags (recursivo full)

Pode ter 10k+ linhas em monorepo com `node_modules`.

---

## Sinal vs ruído

**Sinal:**
- Estrutura de diretórios + arquivos
- Final `N directories, M files` — sumário útil

**Ruído:**
- Conteúdo de `node_modules/`, `.git/`, `dist/`, `target/`, `__pycache__/` — quase sempre não relevante
- Caracteres ASCII art `├── │   └──` — bonitos mas ocupam ~10-15% das linhas

---

## Estratégia proposta

```jsonc
{
  "name": "tree",
  "matchCommand": "^tree(\\s|$)",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\s*[│├└─ ]+(node_modules|\\.git|target|dist|build|__pycache__|\\.venv|\\.cache)/?$"
  ],
  "maxLines": 200
}
```

Mais agressivo: forçar `tree -L 3 -I 'node_modules|.git|...'` por trás. Análogo ao git log forçar `--oneline`.

---

## Edge cases

- [x] `tree --json` — passthrough (estruturado)
- [x] `tree -L N` user já limitou — passthrough ou cap >= N
- [ ] **`-I pattern`** — user já filtrou
- [ ] **`-a`** (mostra hidden) — preservar

---

## Open questions

- [ ] **Instalar `tree` localmente** pra capturar amostras
- [ ] Forçar `-L 3` por trás se user não passou `-L`?
- [ ] Adicionar `tree` à dep do claudio? Não, é responsabilidade do user.

---

## Comparativo com rtk

- rtk: `cmds/system/tree.rs` — implementa filtro nativo.

---

## Findings empíricos

**ZERO empirical findings** — `tree` não instalado.
