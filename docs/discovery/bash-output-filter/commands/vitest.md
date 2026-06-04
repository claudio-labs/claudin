# Command: vitest / jest

**Match pattern:** `^(vitest|jest|npx\s+(vitest|jest)|bun\s+test)\b`
**Família:** js test
**Tier:** 1.5
**Estratégia provável:** declarative (head + tail + preserve FAIL blocks) — gemelar do `pytest.md`
**Status:** **NOT analyzed** (não capturado)
**Estimated reduction:** ~70-90% (gemelar pytest)

---

## Saída crua representativa

⚠️ Não capturado. Padrão típico:

### Vitest pass

```
 RUN  v1.6.0 /home/user/project

 ✓ src/foo.test.ts (12)
 ✓ src/bar.test.ts (8)
 ✓ src/baz.test.ts (15)

 Test Files  3 passed (3)
      Tests  35 passed (35)
   Start at  14:22:05
   Duration  1.23s (transform 234ms, setup 12ms, collect 89ms, tests 456ms)
```

### Vitest fail

```
 FAIL  src/foo.test.ts > MyClass > does the thing
 AssertionError: expected 'a' to equal 'b'
  ❯ src/foo.test.ts:42:15
     40|       const result = subject.process(input)
     41|       // Assert
     42|       expect(result).toBe('expected output')
       |       ^
     43|     })

 Test Files  1 failed | 2 passed (3)
      Tests  1 failed | 34 passed (35)
```

---

## Sinal vs ruído

**Sinal (manter):**
- `RUN` header (vitest version + cwd)
- Nomes de test files com contagem
- FAIL blocks inteiros (caminho + mensagem + snippet com source pointer)
- Linha final (`Test Files X failed | Y passed`)

**Ruído:**
- `Duration` breakdown verbose (`transform 234ms, setup 12ms, collect 89ms, tests 456ms`)
- Linhas em branco entre seções
- `Start at HH:MM:SS` — timestamp absoluto

---

## Estratégia proposta

```jsonc
{
  "name": "vitest",
  "matchCommand": "^(vitest|npx\\s+vitest|bun\\s+test)\\b",
  "stripAnsi": true,
  "stripLinesMatching": [
    "^\\s*Start at\\s",
    "^\\s*$"
  ],
  "replace": [
    { "pattern": "Duration\\s+[\\d.]+s\\s+\\([^)]+\\)", "replacement": "Duration $1s" }
  ],
  "matchOutput": [
    {
      "pattern": "Test Files\\s+\\d+ passed \\(\\d+\\)",
      "message": "✓ vitest: all tests passed",
      "unless": "(?i)\\b(fail|error|warning)\\b"
    }
  ],
  "maxLines": 100
}
```

---

## Edge cases

- [x] `--reporter=json` / `--reporter=verbose` — passthrough (estruturado ou já modo escolhido)
- [x] `--watch` — streaming, fora de escopo
- [x] `is_error: true` — **NÃO** passthrough (exit ≠ 0 = teste falhou, output filtrado é o que precisa)
  - Análogo a `pytest.md`
- [ ] **Snapshot mismatches** — preservar diff inteiro, **podem ser longos**
- [ ] **`--bail`** — output curto, passthrough
- [ ] **Coverage report inline** — pode dobrar tamanho do output, talvez filtrar separado

---

## Open questions

- [ ] **Capturar amostras reais** — claudin usa bun test, capturar saída.
- [ ] **`bun test`** outputs differ from vitest? Provável; padrão é mais conservador.
- [ ] **`jest --silent`** — passthrough.
- [ ] **Vitest UI mode (`--ui`)** — abre browser, fora de escopo.

---

## Comparativo com rtk

- rtk: `cmds/js/vitest_cmd.rs` — implementa filtro nativo.
- **Confirma valor da feature.**

---

## Findings empíricos

**ZERO empirical findings** — não capturado. Próximo passo: rodar `bun test` no claudin com algum subset que termine rápido.
