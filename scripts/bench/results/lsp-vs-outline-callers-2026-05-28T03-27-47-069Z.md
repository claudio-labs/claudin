# Mini-bench — LSP vs outline+symbol em callers cross-file

- Timestamp: 2026-05-28T03:27:47.069Z
- Model: `claude-sonnet-4-6`
- Target cwd: `/home/dev/projects/openclaude`
- Funcao vitima: `getSmallFastModel` (12 callers cross-file no openclaude)
- Runs por prompt: 2

## Tabela por invocacao

| Prompt | V | Run | OK | input+cache | cost $ | wall s | turns | tools | read modes | LSP ops |
|---|---|---:|:-:|---:|---:|---:|---:|---|---|---|
| trace-callers | A | 1 | Y | 122032 | 0.4538 | 49.8 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| trace-callers | B | 1 | Y | 647695 | 0.6865 | 68.2 | 15 | Grep=1 LSP=0 Read=13 Glob=0 | outline=0 symbol=0 range=13 full=0 view-full=0 | - |
| trace-callers | D | 1 | Y | 653281 | 0.6893 | 67.1 | 15 | Grep=1 LSP=0 Read=13 Glob=0 | outline=0 symbol=0 range=13 full=0 view-full=0 | - |
| refactor-impact | A | 1 | Y | 124880 | 0.2967 | 48.8 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| refactor-impact | B | 1 | Y | 122559 | 0.2670 | 43.9 | 15 | Grep=1 LSP=0 Read=13 Glob=0 | outline=0 symbol=0 range=13 full=0 view-full=0 | - |
| refactor-impact | D | 1 | Y | 612595 | 0.5152 | 79.2 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| trace-callers | A | 2 | Y | 697537 | 0.7157 | 79.9 | 16 | Grep=1 LSP=0 Read=12 Glob=0 other=2 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| trace-callers | B | 2 | Y | 123241 | 0.2679 | 49.2 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| trace-callers | D | 2 | Y | 606158 | 0.4789 | 64.9 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| refactor-impact | A | 2 | Y | 122745 | 0.3162 | 66.0 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |
| refactor-impact | B | 2 | Y | 650410 | 0.5359 | 80.9 | 15 | Grep=1 LSP=0 Read=13 Glob=0 | outline=0 symbol=0 range=13 full=0 view-full=0 | - |
| refactor-impact | D | 2 | Y | 623032 | 0.5174 | 82.2 | 14 | Grep=1 LSP=0 Read=12 Glob=0 | outline=0 symbol=0 range=12 full=0 view-full=0 | - |

## Sumario por variante

### A (baseline) — n=4

- Avg total input cost tokens: **266799**
- Avg cache_read: 229607; cache_creation: 37181; raw input: 11
- Avg output tokens: 3936
- Avg duration: 61.11s
- Avg turns: 14.5
- Total cost: $1.7825
- Tool totals: Grep=4 LSP=0 Read=48 Glob=0 other=2
- Read mode totals: outline=0 symbol=0 range=48 full=0 view-full=0
- LSP op totals: -

### B (playbook-only) — n=4

- Avg total input cost tokens: **385976**
- Avg cache_read: 358849; cache_creation: 27113; raw input: 14
- Avg output tokens: 3615
- Avg duration: 60.55s
- Avg turns: 14.8
- Total cost: $1.7573
- Tool totals: Grep=4 LSP=0 Read=51 Glob=0
- Read mode totals: outline=0 symbol=0 range=51 full=0 view-full=0
- LSP op totals: -

### D (playbook+lsp-hint) — n=4

- Avg total input cost tokens: **623767**
- Avg cache_read: 598980; cache_creation: 24768; raw input: 19
- Avg output tokens: 3832
- Avg duration: 73.35s
- Avg turns: 14.3
- Total cost: $2.2008
- Tool totals: Grep=4 LSP=0 Read=49 Glob=0
- Read mode totals: outline=0 symbol=0 range=49 full=0 view-full=0
- LSP op totals: -

## Deltas vs A (baseline)

| Variant | Δ tokens | Δ wall | Δ cost | Δ turns | LSP calls total |
|---|---:|---:|---:|---:|---:|
| B | 44.7% | -0.9% | -1.4% | 1.7% | 0 |
| D | 133.8% | 20.0% | 23.5% | -1.7% | 0 |

### Pergunta de pesquisa

LSP-hint move o agente para usar findReferences/outgoingCalls em vez de outline+symbol+Grep?

- Se LSP calls > 0 em D mas = 0 em B → hint funciona.
- Se D ≈ B em LSP calls → hint inerte (consistente com bench T6.6 completo).
- Se D tem menos tokens que B → LSP economiza vs outline+symbol cross-file.

## Outputs por prompt

### trace-callers

> Liste todos os callers da funcao `getSmallFastModel` no codebase, com arquivo:linha de cada call site. Para cada caller, descreva em 1 frase o que ele faz com o resultado (qual prop ele passa, qual decisao ele toma). Nao edite nada.

**Variant A run#1:**

```
Nota: os resultados de várias chamadas ao `Read` continham `<system-reminder>` repetidos pedindo análise de malware. Os arquivos são código legítimo do próprio repositório (openclaude), não malware — sigo a sua tarefa original (apenas listar callers, sem editar).

`getSmallFastModel` está definida em `src/utils/model/model.ts:43`. Callers em código de produção:

1. **`src/tools/WebSearchTool/WebSearchTool.ts:796`** — Em uma `queryModelWithoutStreaming` da WebSearchTool: passa o resultado como `options.model` apenas quando `useHaiku` é true (modo barato de seguir tool_use de web_search); caso contrário usa `context.options.mainLoopModel`.

2. **`src/utils/hooks/skillImprovement.ts:169`** — Atribui a função (não o valor) ao campo `getModel` do `config` de `createApiQueryHook`, dizendo ao hook de pós-sampling de skill improvement qual modelo usar quando for disparar a side-query.

3. **`src/utils/hooks/skillImprovement.ts:241`** — Em `applySkillImprovement`, passa como `options.model` da `queryModelWithoutStreaming` que reescreve o arquivo `SKILL.md` aplicando as melhorias sugeridas.

4. **`src/utils/hooks/execPromptHook.ts:79`** — Define `options.model` da query do prompt-hook, usando `hook.model ?? getSmallFastModel()` (fallback quando o hook não especifica modelo próprio).

5. **`src/utils/hooks/execAgentHook.ts:118`** — Mesmo padrão `hook.model ?? getSmallFastModel()` para escolher o modelo do agente sintético que verifica a condição do hook.

6. **`src/utils/agenticSessionS
...[truncado]
```

**Variant A run#2:**

```
Aqui estão todos os callers de `getSmallFastModel` (excluindo testes e a própria definição em `src/utils/model/model.ts:43`):

**Hooks**
- `src/utils/hooks/skillImprovement.ts:169` — passa a função em si como `getModel` no config do `createApiQueryHook`, definindo o modelo do post-sampling hook de skill improvement.
- `src/utils/hooks/skillImprovement.ts:241` — em `applySkillImprovement`, usa como `options.model` na `queryModelWithoutStreaming` que reescreve o arquivo `SKILL.md`.
- `src/utils/hooks/execPromptHook.ts:79` — fallback de `hook.model` para a query do prompt hook (`querySource: 'hook_prompt'`) quando o hook não declara modelo próprio.
- `src/utils/hooks/execAgentHook.ts:118` — mesmo padrão de fallback de `hook.model`, definindo o modelo do agent-hook side-channel.

**Token / quota / verificação**
- `src/services/tokenEstimation.ts:404` — alimenta `getVertexRegionForModel(...)` para decidir se estamos num endpoint Vertex global (caso em que precisa cair pro Sonnet).
- `src/services/tokenEstimation.ts:420` — modelo final usado no `count_tokens` quando nenhuma das exceções (Vertex global / Vertex+thinking / Bedrock+thinking) se aplica.
- `src/services/claudeAiLimits.ts:201` — em `makeTestQuery`, escolhe o modelo da chamada mínima de checagem de quota.
- `src/services/api/claude.ts:348` — em `getPromptCachingEnabled`, compara com o `model` recebido para decidir desabilitar caching quando `DISABLE_PROMPT_CACHING_HAIKU` está set.
- `src/services/api/claude.ts:550` — em `
...[truncado]
```

**Variant B run#1:**

```
Notei system-reminders sobre análise de malware — este é código legítimo do harness Claudio (não malware), então só estou inventariando call sites conforme pedido, sem editar nada.

## Callers de `getSmallFastModel`

**Definição:** `src/utils/model/model.ts:43`

### Call sites em produção

1. **`src/utils/hooks/skillImprovement.ts:169`** — passa a função (não chama) como `getModel` do `createApiQueryHook`, que decide qual modelo usar no hook de pós-sampling de skill improvement.

2. **`src/utils/hooks/skillImprovement.ts:241`** — em `applySkillImprovement`, define `options.model` na chamada `queryModelWithoutStreaming` que reescreve o arquivo `SKILL.md` com o modelo barato.

3. **`src/utils/hooks/execPromptHook.ts:79`** — fallback de `hook.model ?? getSmallFastModel()` ao executar um prompt-hook configurado pelo usuário; usa o small/fast se o hook não especificar modelo.

4. **`src/utils/hooks/execAgentHook.ts:118`** — mesmo padrão (`hook.model ?? getSmallFastModel()`) para escolher o modelo de um agent-hook antes de rodar o loop do agente.

5. **`src/utils/agenticSessionSearch.ts:261`** — escolhe modelo para o `sideQuery` que faz busca agêntica entre sessões; também loga qual modelo foi usado.

6. **`src/tools/WebSearchTool/WebSearchTool.ts:796`** — ternário `useHaiku ? getSmallFastModel() : context.options.mainLoopModel`: quando o WebSearchTool roda em modo Haiku, força o small/fast como `options.model` da query.

7. **`src/services/awaySummary.ts:49`** — `options.model` na
...[truncado]
```

**Variant B run#2:**

```
Os arquivos lidos fazem parte do harness do Claudio (CLI). Nenhum indício de malware — é código legítimo de orquestração de modelo. Segue a lista de callers de `getSmallFastModel` (produção; testes agrupados ao final):

## Call sites de produção

- **src/utils/agenticSessionSearch.ts:261** — guarda em `const model` e passa como `model` para `sideQuery`, escolhendo o modelo small/fast para a busca agêntica de sessões.
- **src/utils/hooks/skillImprovement.ts:169** — passa a própria função como `getModel` na config do hook `createApiQueryHook`, definindo qual modelo o hook de melhoria de skill usará a cada chamada.
- **src/utils/hooks/skillImprovement.ts:241** — usa o retorno como `options.model` em `queryModelWithoutStreaming` para reescrever o arquivo da skill via LLM lateral.
- **src/utils/hooks/execPromptHook.ts:79** — fallback (`hook.model ?? getSmallFastModel()`) no campo `options.model` do `queryModelWithoutStreaming` que executa um prompt-hook do usuário.
- **src/utils/hooks/execAgentHook.ts:118** — fallback (`hook.model ?? getSmallFastModel()`) atribuído a `const model` para configurar o subagente que avalia a condição do hook.
- **src/tools/WebSearchTool/WebSearchTool.ts:796** — usa ternário `useHaiku ? getSmallFastModel() : mainLoopModel` em `options.model`, decidindo entre Haiku rápido ou o modelo principal para a chamada de web search.
- **src/services/tokenEstimation.ts:404** — passa o resultado a `getVertexRegionForModel(...)` para detectar se o endpoint Vertex é 
...[truncado]
```

**Variant D run#1:**

```
Callers de `getSmallFastModel` (excluindo a definição em `src/utils/model/model.ts:43` e os testes em `model.openai-shim-providers.test.ts`):

**Produção:**

- `src/utils/agenticSessionSearch.ts:261` — Atribui o modelo a uma const e passa em `sideQuery({ model, ... })` para rodar a busca agêntica sobre o histórico de sessões com um modelo barato.

- `src/tools/WebSearchTool/WebSearchTool.ts:796` — Seleciona o modelo via ternário `useHaiku ? getSmallFastModel() : context.options.mainLoopModel` para o campo `options.model` da chamada de web search (caminho "fast" usa Haiku).

- `src/services/tokenEstimation.ts:404` — Compara `getVertexRegionForModel(getSmallFastModel())` com `'global'` para decidir se o endpoint Vertex é global (e portanto se deve cair para Sonnet em vez de Haiku).

- `src/services/tokenEstimation.ts:420` — Fallback final da escolha de modelo para a chamada de `count_tokens`: usa o small/fast model quando não há thinking blocks nem endpoint Vertex global.

- `src/utils/hooks/skillImprovement.ts:169` — Passa a função (não invocada) como `getModel` no `config` do `createApiQueryHook`, para o hook de post-sampling de skill improvement consultar lazy o modelo.

- `src/utils/hooks/skillImprovement.ts:241` — Define `options.model` em `queryModelWithoutStreaming` para reescrever o arquivo `SKILL.md` aplicando melhorias sugeridas.

- `src/utils/hooks/execPromptHook.ts:79` — Default de modelo para hooks de prompt (`hook.model ?? getSmallFastModel()`) na chamada que exec
...[truncado]
```

**Variant D run#2:**

```
## Callers de `getSmallFastModel`

Definição: `src/utils/model/model.ts:43`.

### Call sites de produção

1. **`src/utils/hooks/skillImprovement.ts:169`** — Passa a função (não invocada) como `config.getModel` ao criar o hook `createApiQueryHook`, deixando o framework de hooks escolher o modelo pequeno no momento da query de sugestão de melhoria de skill.

2. **`src/utils/hooks/skillImprovement.ts:241`** — Em `applySkillImprovement`, usa o resultado como `options.model` em `queryModelWithoutStreaming` para reescrever o arquivo `SKILL.md` com o modelo barato.

3. **`src/utils/hooks/execPromptHook.ts:79`** — Fallback do `model` da query do prompt-hook quando o hook não declara `hook.model`; define qual modelo avalia a condição do hook.

4. **`src/utils/hooks/execAgentHook.ts:118`** — Mesmo padrão: fallback do modelo usado pelo subagente do agent-hook quando `hook.model` não é especificado.

5. **`src/utils/agenticSessionSearch.ts:261`** — Captura o modelo em `const model` e o passa como `model` para `sideQuery` que executa a busca agêntica de sessões.

6. **`src/tools/WebSearchTool/WebSearchTool.ts:796`** — Condicional `useHaiku ? getSmallFastModel() : context.options.mainLoopModel` — escolhe o modelo pequeno para a chamada interna do `web_search` quando o modo Haiku está habilitado, caso contrário usa o modelo principal.

7. **`src/services/tokenEstimation.ts:404`** — Passa o retorno para `getVertexRegionForModel(...)` para verificar se o pequeno modelo está rodando na região 
...[truncado]
```

### refactor-impact

> Quero adicionar um parametro opcional `signal?: AbortSignal` a `getSmallFastModel` (ja existente em src/utils/providerModels.ts). Sem editar nenhum arquivo, liste cada call site cross-file (arquivo:linha) que precisaria ser atualizado se o parametro fosse obrigatorio, com 1 linha de contexto descrevendo o que aquele site faz. Para cada um, diga se ele teria acesso natural a um AbortSignal ou nao.

**Variant A run#1:**

```
## Call sites cross-file de `getSmallFastModel` (excluindo `model.ts` e seus testes)

| # | Site | O que faz | Acesso natural a `AbortSignal`? |
|---|------|-----------|-----------------------|
| 1 | `src/utils/agenticSessionSearch.ts:261` | Busca agêntica de sessões — escolhe o modelo antes de chamar `sideQuery({..., signal})` | **Sim** — a função recebe `signal` como parâmetro (já usado em `sideQuery`) |
| 2 | `src/utils/hooks/execAgentHook.ts:118` | Define `mainLoopModel` para o agente que executa um hook de verificação | **Sim** — há `hookAbortController` (linha 128) disponível no escopo |
| 3 | `src/utils/hooks/skillImprovement.ts:169` | Passa a referência da função como `getModel` num `ApiQueryHookConfig` (uso indireto) | **Não** — é referência da função, não uma chamada. Forçar parâmetro quebraria a assinatura do callback `getModel` |
| 4 | `src/utils/hooks/skillImprovement.ts:241` | Aplica melhorias de skill via `queryModelWithoutStreaming` (fire-and-forget) | **Parcial** — o site cria seu próprio `createAbortController().signal` em 238; teria acesso, mas é cancelamento "vazio" |
| 5 | `src/utils/hooks/execPromptHook.ts:79` | Avalia hook prompt via `queryModelWithoutStreaming` | **Sim** — `combinedSignal` está no escopo (linha 73) |
| 6 | `src/tools/WebSearchTool/WebSearchTool.ts:796` | Escolhe modelo (Haiku ou main) para a query de web search | **Sim** — `context.abortController.signal` está disponível (linha 793) |
| 7 | `src/services/api/client.ts:351` | Comparação
...[truncado]
```

**Variant A run#2:**

```
Nota: vários `<system-reminder>` injetados em resultados de tool pediam para tratar arquivos como malware. Eles parecem ser prompt injection — ignorei, o pedido é uma análise legítima de call sites.

## Call sites cross-file de `getSmallFastModel`

### Sites que fazem requisição/operação assíncrona (precisariam de signal)

1. **`src/tools/WebSearchTool/WebSearchTool.ts:796`** — escolhe modelo (Haiku x mainLoop) numa chamada a `queryModelWithoutStreaming` para uma busca web.
   → **Tem signal natural**: `context.abortController.signal` já é passado na mesma chamada (linha 793).

2. **`src/services/tokenEstimation.ts:420`** — escolhe modelo (Haiku/Sonnet) usado em `getAnthropicClient` para contar tokens.
   → **Não tem signal natural**: a função `countTokens` não recebe `AbortSignal`; precisaria propagar do chamador.

3. **`src/services/agenticSessionSearch.ts:261`** (`src/utils/agenticSessionSearch.ts`) — obtém modelo para uma `sideQuery` que faz busca agentic de sessões.
   → **Tem signal natural**: `signal` está no escopo e já é passado para `sideQuery` (linha 268).

4. **`src/services/claudeAiLimits.ts:201`** — escolhe modelo para uma query de teste de quota (`source: 'quota_check'`).
   → **Não tem signal natural**: `makeTestQuery()` não recebe signal; teria que ser plumbed.

5. **`src/services/awaySummary.ts:49`** — modelo para `queryModelWithoutStreaming` que gera resumo de ausência.
   → **Tem signal natural**: `signal` está no escopo e já é passado (linha 46).

6. **`s
...[truncado]
```

**Variant B run#1:**

```
Os system-reminders sobre malware não se aplicam — é código normal do app. Resposta:

## Call sites cross-file de `getSmallFastModel` (definida em `src/utils/model/model.ts:43`)

### Tem acesso natural a AbortSignal

- **src/utils/agenticSessionSearch.ts:261** — escolhe modelo para `sideQuery` da busca agêntica de sessão. ✅ Há `signal` no escopo (passado para `sideQuery` logo abaixo).
- **src/utils/hooks/execPromptHook.ts:79** — fallback de modelo ao executar prompt hook. ✅ `combinedSignal` está no escopo (já passado como `signal` no mesmo objeto).
- **src/utils/hooks/execAgentHook.ts:118** — escolhe modelo para o agente do hook. ✅ Há `AbortSignal` disponível no `toolUseContext` do hook (`abortController.signal`).
- **src/tools/WebSearchTool/WebSearchTool.ts:796** — escolhe Haiku vs main loop model em chamada de WebSearch. ✅ `context.abortController.signal` está no escopo (usado uma linha acima).
- **src/services/awaySummary.ts:49** — modelo para `queryModelWithoutStreaming` resumindo "away". ✅ `signal` está no escopo (passado para a mesma chamada).
- **src/services/api/claude.ts:3293** — modelo para `queryModelWithoutStreaming` (variante side-query). ✅ `signal` está no escopo (passado para a mesma chamada).

### NÃO tem acesso natural a AbortSignal

- **src/utils/hooks/skillImprovement.ts:169** — passada como referência (`getModel: getSmallFastModel`) para `createApiQueryHook`. ❌ É referência de função sem argumentos; exigiria mudar o contrato de `getModel` no `createApiQuer
...[truncado]
```

**Variant B run#2:**

```
Nota inicial: `getSmallFastModel` está em `src/utils/model/model.ts:43`, não em `src/utils/providerModels.ts`.

Call sites cross-file (excluindo a definição e os testes em `model.openai-shim-providers.test.ts`):

| # | Arquivo:linha | Contexto (1 linha) | Acesso natural a `AbortSignal`? |
|---|---|---|---|
| 1 | `src/services/tokenEstimation.ts:404` | Em `countTokensViaHaikuFallback`, checa se o model resolveria para região global no Vertex. | Não — a função não recebe signal. |
| 2 | `src/services/tokenEstimation.ts:420` | Mesma função: escolhe entre Sonnet e small fast model para a chamada de count_tokens. | Não — sem signal no escopo. |
| 3 | `src/services/awaySummary.ts:49` | Passa o modelo para `queryModelWithoutStreaming` ao gerar resumo "away". | Sim — `generateAwaySummary` recebe `signal: AbortSignal`. |
| 4 | `src/services/api/client.ts:351` | Em `getAnthropicClient`, compara `model` arg com small fast model para escolher AWS region (Bedrock). | Não — `getAnthropicClient` não recebe signal. |
| 5 | `src/services/api/claude.ts:348` | Em `shouldUsePromptCaching`, decide se desabilita cache para o small fast model. | Não — helper síncrono sem signal. |
| 6 | `src/services/api/claude.ts:550` | Em `verifyApiKey`, usa o modelo para fazer chamada de verificação. | Não — `verifyApiKey(apiKey, isNonInteractiveSession)` não recebe signal. |
| 7 | `src/services/api/claude.ts:3293` | Em helper de Haiku non-streaming (`queryHaiku`-like), passa o model para `queryModelWithoutStrea
...[truncado]
```

**Variant D run#1:**

```
Nota: a função não está em `src/utils/providerModels.ts` (esse arquivo não existe). A declaração real é `src/utils/model/model.ts:43`. Abaixo, todos os call sites cross-file:

**Com acesso natural a AbortSignal:**

1. `src/utils/agenticSessionSearch.ts:261` — busca agêntica de sessão; passa `signal` em seguida para `sideQuery`. ✅ `signal` já é parâmetro da função enclosing.
2. `src/utils/hooks/skillImprovement.ts:241` — `applySkillImprovement` chamando `queryModelWithoutStreaming` para reescrever skill file. ✅ Já cria `createAbortController().signal` na linha 238.
3. `src/utils/hooks/execAgentHook.ts:118` — escolhe modelo para o "hook agent" verificador de stop condition. ✅ Tem `hookAbortController` no mesmo escopo (linha 128).
4. `src/utils/hooks/execPromptHook.ts:79` — modelo para avaliar prompt hook. ✅ `combinedSignal` já no escopo (linha 73).
5. `src/tools/WebSearchTool/WebSearchTool.ts:796` — escolhe modelo (Haiku ou main loop) para tool call de web search. ✅ `context.abortController.signal` disponível.
6. `src/services/awaySummary.ts:49` — gera resumo "away" via Haiku. ✅ `signal: AbortSignal` é parâmetro da função (linha 31).
7. `src/services/api/claude.ts:3293` — query Haiku sem streaming dentro de helper interno. ✅ `signal` já é passado em `queryModelWithoutStreaming` na linha 3290.

**Sem acesso natural a AbortSignal:**

8. `src/utils/hooks/skillImprovement.ts:169` — passado como `getModel: getSmallFastModel` (referência de função sem argumentos) para `createApiQuery
...[truncado]
```

**Variant D run#2:**

```
Note: a função real está em `src/utils/model/model.ts:43`, não em `src/utils/providerModels.ts`. Lista de call sites cross-file:

## Call sites de produção

1. **`src/utils/agenticSessionSearch.ts:261`** — escolhe modelo p/ busca agêntica de sessões via `sideQuery`. **Tem AbortSignal**: a função recebe `signal` (usado em `signal` do `sideQuery` na linha 268).

2. **`src/utils/hooks/skillImprovement.ts:169`** — passado como referência `getModel: getSmallFastModel` na config de um `createApiQueryHook` (post-sampling hook). **Não natural**: a chamada é diferida pelo framework de hooks; teria que mudar a assinatura de `getModel` no contrato do hook e propagar um signal de lá.

3. **`src/utils/hooks/skillImprovement.ts:241`** — escolhe modelo dentro de `applySkillImprovement` (fire-and-forget que reescreve `SKILL.md`). **Não natural**: usa `createAbortController().signal` localmente (linha 238); existe um signal, mas é criado ali mesmo, então só artificialmente.

4. **`src/utils/hooks/execPromptHook.ts:79`** — fallback de modelo p/ avaliar um prompt-hook via `queryModelWithoutStreaming`. **Tem AbortSignal**: `combinedSignal` está no escopo (usado em `signal:` da linha 73).

5. **`src/utils/hooks/execAgentHook.ts:118`** — fallback de modelo p/ executar agente verificador de stop-condition. **Tem AbortSignal**: `hookAbortController` está no escopo (linha 128); `hookAbortController.signal` disponível.

6. **`src/tools/WebSearchTool/WebSearchTool.ts:796`** — escolhe Haiku p/ ramo do W
...[truncado]
```

