# Command: <NOME DO COMANDO>

**Match pattern:** `^<comando>\b`
**Família:** <git | fs | js | rust | python | docker | cloud | outro>
**Tier:** 1 | 2
**Estratégia provável:** declarative pipeline | native parser | hybrid
**Status:** candidate
**Estimated reduction:** N% (fonte: rtk README | medido | TBD)

---

## Saída crua representativa

Coletar 2-3 amostras reais (trivial, médio, grande) e colar aqui em fences. Anotar tamanho.

### Amostra 1 — caso trivial (~N bytes)

```
<output cru>
```

### Amostra 2 — caso médio (~N bytes)

```
<output cru>
```

### Amostra 3 — caso grande (~N bytes)

```
<output cru>
```

---

## Sinal vs ruído

**Sinal (manter no output filtrado):**
- ...

**Ruído (remover):**
- ...

**Ambíguo (debater):**
- ...

---

## Estratégia proposta

Escolher uma:

### Opção A — pipeline declarativo

```jsonc
{
  "name": "<nome>",
  "matchCommand": "^<regex>",
  "stripAnsi": true,
  "stripLinesMatching": ["..."],
  "replace": [{ "pattern": "...", "replacement": "..." }],
  "matchOutput": [
    { "pattern": "...", "message": "...", "unless": "..." }
  ],
  "headLines": null,
  "tailLines": null,
  "maxLines": null,
  "truncateLineAt": null,
  "onEmpty": null
}
```

### Opção B — native parser

Pseudocódigo do parser (motivar custo de manutenção):

```ts
function compact<Cmd>(raw: string): string {
  // ...
}
```

**Justificativa pra escolher native** (precisa, senão default é declarativo):

- ...

---

## Edge cases / NÃO filtrar quando

- [ ] `is_error: true` → passthrough (regra geral, não específica do comando)
- [ ] Saída contém JSON válido → passthrough
- [ ] Output em locale ≠ en → testar regex com `LANG=fr_FR.UTF-8`
- [ ] Flag `--json` ou `--porcelain` ou `-o json` → passthrough (já é compacto/estruturado)
- [ ] Caractere especial no payload (newline em filename, regex meta) → ...
- [ ] Comando customizado pelo user (alias, wrapper) → ...

---

## Estimativa de redução

Antes vs depois das amostras coletadas acima:

| Amostra | Antes (bytes) | Depois (bytes) | Redução |
|---|---|---|---|
| trivial | N | N | N% |
| médio | N | N | N% |
| grande | N | N | N% |

---

## Open questions

- [ ] ...
- [ ] ...

---

## Comparativo com rtk

- Filtro rtk equivalente: `<rtk/src/cmds/...>` ou `<rtk/src/filters/*.toml>`
- Diferenças relevantes: ...
- O que copiamos / o que mudamos: ...
