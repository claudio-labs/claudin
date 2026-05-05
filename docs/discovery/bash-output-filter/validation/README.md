# Validation harness

Pequeno protótipo do pipeline de filtros pra **validar empiricamente** as estratégias propostas em `commands/*.md` contra dados reais.

## Como rodar

```bash
bun run docs/discovery/bash-output-filter/validation/validate.ts
```

Saída no console + `results.md` com tabela detalhada.

## Estrutura

```
validation/
├── README.md           # este arquivo
├── pipeline.ts         # implementação minimal do pipeline (8 estágios, ~150 linhas)
├── validate.ts         # casos de teste + safety tests + runner + report writer
├── samples/            # outputs reais capturados de comandos no ambiente local
│   ├── git-status.txt
│   ├── git-log-default.txt
│   ├── ...
└── results.md          # gerado por validate.ts — atualizado a cada run
```

## O que valida

Para cada `(comando, sample, filter spec)`:

1. **Match correto:** `matchCommand` casa, `matchCommandReject` (se presente) também faz seu papel.
2. **Reduction real vs prevista:** com tolerância de ±15pp.
3. **Output não vazio:** pipeline não pode gerar string vazia (sinal de over-stripping).
4. **Regex defensivos:** flags em ⚠ se nenhum strip pattern casa nada (não-error, mas vale revisar).

Plus **safety tests** sintéticos:
- Injeta keywords de erro/warning em inputs e verifica que `match_output` com `unless` **NÃO engole** mensagem crítica.

## Como adicionar novo caso

1. Capturar sample real:
   ```bash
   <comando> > docs/discovery/bash-output-filter/validation/samples/<nome>.txt 2>&1
   ```
2. Adicionar entrada em `CASES` array em `validate.ts`:
   ```ts
   {
     name: 'descrição',
     command: '<comando>',
     sampleFile: '<nome>.txt',
     predictedReductionPct: <esperado>,
     filter: { name: '...', matchCommand: /.../, ... },
   }
   ```
3. Rodar `bun run validate.ts`.

## Como adicionar safety test

Em `SAFETY_TESTS` array:

```ts
{
  name: 'filter X must preserve <keyword> in error case',
  inputWithError: 'synthetic input with error keyword',
  errorKeyword: 'word to verify',
  filter: findCase('matching test case name'),
}
```

## Status atual

**46 cases pipeline + 3 safety tests, 100% passing.**

Cobertura empírica (com dados reais capturados):
- **Git family:** status, log default, log oneline, diff, add, push, show, blame, branch
- **File system:** ls -la, ls plain, find, tail, cat (skiplist), du, df
- **Search:** grep abs, rg abs, rg rel
- **Build/test:** cargo build/check/test, tsc, ruff (clean+errors), pytest, bun test
- **Network:** curl -v, dig, ss
- **Container:** docker ps, docker logs, docker images
- **System:** ps aux, top, journalctl
- **Package mgr:** bun install, npm ls
- **Data tools:** jq, env, ip addr (capturados, alguns sem filter dedicado)
- **Synthetic:** progress bar, retry loop (test dedup features)

Findings principais documentados em [`../README.md`](../README.md) → log de decisões.

## Limitações

- Pipeline é **simplified** — não testa `headLines + tailLines` (precisa sample com 100+ linhas distintas).
- **Não valida match_output `message` substitution** (`$1`, `${COUNT}` etc.) — capturas implícitas estão no `pattern`, mas resultado direto vai como string fixa.
- **Não testa `is_error: true`** passthrough — esse comportamento é responsabilidade do BashTool, não do pipeline puro.
- Samples são **um snapshot** do ambiente local — git status/diff variam por estado do repo.
