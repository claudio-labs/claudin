# Command: cat / head / tail / less

**Match pattern:** `^(cat|head|tail|less)\s`
**Família:** fs (read)
**Tier:** **Tier 2** ou descartar
**Estratégia provável:** **passthrough quase sempre**
**Status:** analyzed (real data)
**Estimated reduction:** **~0%** no caso geral

---

## Saída crua representativa (claudin repo, 5 May 2026)

### Amostra REAL — `cat CLAUDE.md` (12.175 bytes)

Output é o conteúdo literal do arquivo. **100% sinal por definição.**

### Amostras conceituais

- `cat foo.json` — JSON válido, **passthrough sempre**
- `cat large.log` (100MB) — output gigantesco, mas summarizer existente cobre via threshold
- `head -100 file.txt` — user já limitou
- `tail -50 file.log` — user já limitou
- `cat file1 file2 file3` — concatenação, sem separator (ruído potencial?)

---

## Sinal vs ruído

**Sinal:** todo o conteúdo (100%).

**Ruído:** zero. Conteúdo do arquivo é exatamente o que o user pediu pra ver.

---

## Estratégia proposta

### **Não criar filtro.**

Razões:
1. **claudin tem `FileReadTool`** que é o mecanismo correto pra ler arquivos. Bash `cat` é fallback (em pipes ou contextos onde FileReadTool não cabe).
2. Output é o file content — qualquer modificação é perigosa.
3. O **summarizer existente** já cobre quando o output for >10KB (threshold READ).

### Caso edge: `cat <binary-file>`

User pode fazer `cat /usr/bin/something` — output é binário, lixo no terminal. Mesmo assim:
- Preferir não filtrar (modelo deve aprender a não fazer isso)
- summarizer pode capturar via threshold + detect non-printable chars (não testado)

---

## Edge cases / NÃO filtrar quando

- [x] Sempre passthrough — não há regra "quando filtrar"

---

## Estimativa de redução

| Cenário | Antes | Depois | Redução |
|---|---|---|---|
| `cat CLAUDE.md` (REAL: 12.175 bytes) | 12.175 | 12.175 | **0%** |
| `cat large.log` (>10KB) | 100.000+ | head/tail via summarizer | (não nosso problema) |
| `head -10 file` | ~500 | ~500 | 0% |

---

## Open questions

- Nenhuma — recomendação clara: **não criar filtro Bash**.

---

## Comparativo com rtk

- rtk: `cmds/system/read.rs` — implementa filtro (provavelmente truncate em arquivos grandes).
- **Diferença:** rtk substitui `cat` por sua versão; claudin tem FileReadTool dedicada que faz papel similar **sem precisar de Bash filter**.

---

## Findings empíricos

1. **`cat` é incompressível** — content é signal puro.
2. **claudin's FileReadTool** já é o caminho correto pra reads diretos.
3. **summarizer existente** cobre o caso "cat de file gigante" via threshold.
4. **Recomendação final:** adicionar `^(cat|head|tail|less)\s` ao match-pattern do filtro Bash como **default reject** (não tentar aplicar nenhum filtro).
