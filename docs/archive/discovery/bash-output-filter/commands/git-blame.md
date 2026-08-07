# Command: git blame

**Match pattern:** `^git(\s+-[^\s]+)*\s+blame\b`
**Família:** git
**Tier:** 1 (validado)
**Estratégia provável:** declarative (replace do block author+timezone)
**Status:** **VALIDATED** — sample real claudin repo
**Estimated reduction:** **25%** (medido)

---

## Saída crua representativa (REAL: README.md head -30, 2.867 bytes)

```
^b8dc2bb (Viudes 2026-04-29 18:08:59 -0300   1) # Claudin
^b8dc2bb (Viudes 2026-04-29 18:08:59 -0300   2) 
23551ecd (Viudes 2026-05-02 11:28:25 -0300   3) Claudin is a coding-agent CLI for cloud and local model providers.
... (mais linhas)
```

Cada linha tem `^?hash (Author Name YYYY-MM-DD HH:MM:SS +TZ N)` ~50 chars de metadata antes do conteúdo real.

---

## Sinal vs ruído

**Sinal:**
- Hash curto (8 chars) — referenciável
- Data — útil pra entender quando linha foi escrita
- Número da linha
- Conteúdo (após `)`)

**Ruído:**
- Author name (múltiplas palavras quando autor tem nome composto)
- Timezone (`+TZ` ou `-TZ`) — raramente acionável
- Hora exata (`HH:MM:SS`)

---

## Estratégia validada

```jsonc
{
  "name": "git-blame",
  "matchCommand": "^git(\\s+-[^\\s]+)*\\s+blame\\b",
  "stripAnsi": true,
  "replace": [
    // ^hash (Author YYYY-MM-DD HH:MM:SS +TZ N) → ^hash YYYY-MM-DD N)
    // Hash pode ser 7 chars (boundary commit com ^ prefix) ou 8+
    { "pattern": "(\\^?[0-9a-f]{7,8})\\s+\\([^)]+?(\\d{4}-\\d{2}-\\d{2})\\s+\\d{2}:\\d{2}:\\d{2}\\s+[+\\-]\\d{4}\\s+(\\d+)\\)", "replacement": "$1 $2 $3)" }
  ]
}
```

**Saída esperada (Amostra 1, 25% redução):**

```
^b8dc2bb 2026-04-29 1) # Claudin
^b8dc2bb 2026-04-29 2) 
23551ecd 2026-05-02 3) Claudin is a coding-agent CLI for cloud and local model providers.
```

---

## Edge cases

- [x] **Boundary commits** com `^` prefix (initial commits) — regex aceita 7-8 chars hex
- [x] `--porcelain` → passthrough (formato estruturado)
- [x] `is_error: true` → passthrough
- [ ] **`-w` (ignore whitespace)** — output igual, filter funciona
- [ ] **`-M` / `-C` (detect moved)** — output igual
- [ ] **Linha sem `Author Name` (raro)** — não casa, preserva

---

## ROI medido

| Cenário | Antes | Depois | Redução |
|---|---|---|---|
| **README.md head -30 (REAL)** | **2.867** | ~2.150 | **25%** |
| Arquivo grande (1000 linhas) | ~100.000 | ~75.000 | ~25% |

---

## Findings empíricos

1. **Boundary commits** (`^abc1234` com 7 chars) são caso comum em repos novos — meu regex inicial pegou só 9 de 31 linhas. Lição: testar contra repos reais sempre.
2. **25% é consistente** — ~30 chars de metadata × N linhas = ganho linear.
3. **Cumulativo significativo** — `git blame` em arquivo grande gera 100KB facilmente; 25% = 25KB economizados por chamada.
