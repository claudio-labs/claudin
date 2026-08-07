# LSP vs Grep — Ground Truth

**Objetivo**: medir, sem agente no loop, se LSP entrega resultados qualitativamente melhores que Grep nos 5 cenários simbólicos canônicos.

**Motivação**: o Tier 6.1 do roadmap (editar tool descriptions pra preferir LSP) foi testado empiricamente em 2 rodadas de bench A/B. Resultado: description não muda comportamento (rodada 1, claudin) ou muda pro lado errado (rodada 2, openclaude — agente fica mais elaborado mas não migra pra LSP, custo +57%). Antes de iterar incentivo, validar a premissa: **LSP é de fato melhor?**

**Repo de medição**: `claudin` (este repo). TS-only, ~250 arquivos. LSP server: `typescript-language-server`.

## Critérios de avaliação por cenário

| Critério | Como medir |
|---|---|
| **Cobertura** | Encontra todas as ocorrências relevantes? |
| **Ruído** | Quantos falsos positivos (comentários, strings, homônimos)? |
| **Tempo** | Wall-clock até resposta completa |
| **Output tokens** | Tamanho do retorno (estimado por chars/4) |

## Cenários

1. [Prompt 1 — callers de `tryGetActiveProvider`](01-callers.md)
2. [Prompt 2 — `documentSymbol` de `activeProvider.ts`](02-document-symbol.md)
3. [Prompt 3 — go-to-def de `ToolDef`](03-go-to-def.md)
4. [Prompt 4 — call hierarchy de `saveGlobalConfig` (2 níveis)](04-call-hierarchy.md)
5. [Prompt 5 — refs do tipo `SDKMessage` em `src/services/api/`](05-type-refs.md)

## Veredito

Ver [VERDICT.md](VERDICT.md) ao final.
