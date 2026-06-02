# WebResearcher — subagent built-in para research multi-página

**Status:** Implementado (2026-05-16)
**Roadmap:** item 8.0
**Arquivos:** `src/tools/AgentTool/built-in/webResearcherAgent.ts`

## O que é

`WebResearcher` é um subagent built-in que o agente principal pode chamar via `AgentTool` quando precisa de pesquisa em múltiplas páginas da web. Roda em **contexto isolado**, com acesso somente a `WebSearch` e `WebFetch`, e devolve ao pai **uma única síntese textual com URLs citadas**.

## Problema que resolve

Antes deste subagent, perguntas como *"como configurar OAuth device flow no provider X"* faziam o modelo principal encadear 5–7 `WebFetch`/`WebSearch` diretos. Cada `WebFetch` despejava 3–5k tokens de HTML convertido no histórico principal — ou seja, ~20k tokens de browsing mecânico ocupando contexto caro (normalmente Opus) em sessões longas.

Com o `WebResearcher`:

- HTML cru fica no contexto do filho (descartado ao final).
- Pai recebe só a síntese final (centenas de tokens, não dezenas de milhares).
- Filho roda em `haiku` (~10× mais barato que Opus) — o trabalho mecânico não consome o modelo caro.

## Quando o pai escolhe `WebResearcher` vs. as tools diretas

A descrição (`whenToUse`) injetada no prompt do `AgentTool` deixa explícito:

| Cenário | Escolha |
|---|---|
| Pesquisa em 3+ páginas, tópico amplo | `Agent(WebResearcher)` |
| Buscar uma URL específica conhecida | `WebFetch` direto |
| Descobrir links sobre um termo | `WebSearch` direto |
| Algo no repo local | `Agent(Explore)` |

A escolha é do modelo pai — não há roteamento automático.

## Decisões de design

| Decisão | Valor | Motivo |
|---|---|---|
| `tools` allowlist | `[WebSearch, WebFetch]` | Escopo puro web público; sem leitura local nem MCP. Allowlist não regride se novas write-tools forem adicionadas. |
| `model` | `'haiku'` | Mais barato dos aliases first-party. Resolve corretamente em Anthropic/Bedrock/Vertex/Foundry. **Atenção**: em providers OpenAI-shim (OpenRouter, Gemini, DeepSeek, Mistral, etc.), `'haiku'` cai no modelo do pai — ver "Override de modelo" abaixo. |
| `omitClaudeMd` | `true` | Research na web não precisa de regras de commit/lint/typescript do projeto. |
| `omitGitStatus` | `true` | Web research nunca toca o repo local; o blob de gitStatus (até 40KB) é puro desperdício. |
| One-shot trailer | `ONE_SHOT_BUILTIN_AGENT_TYPES` | Parent não recebe `agentId`/SendMessage/usage trailer — economiza ~135 chars por chamada. |
| `permissionMode` | herdar (não definir) | Domain check do `WebFetch` em domínio novo continua pedindo aprovação na UI do pai. |
| Feature flag | — | Sem gate; sempre on. |
| `SendMessage` (continuar subagent) | não incluído | Mantém pureza/isolamento. Pai lança um novo `WebResearcher` se precisar refinar. |

### Por que `'haiku'` e não hardcode de Gemini Flash / DeepSeek?

Hardcode de provider específico violaria a regra "no hardcoded provider logic" do `CLAUDE.md` e quebraria para quem não configurou esse provider. `'haiku'` é o mais barato dos aliases universais.

### Override de modelo (importante para non-Anthropic providers)

Em providers que não são Claude-native (qualquer coisa que passe pelo `openaiShim`: OpenRouter, Gemini, DeepSeek, Mistral, LM Studio, Together, etc.), `resolveAgentModel` em `src/utils/model/agent.ts` (procure pela checagem `checkIsClaudeNativeProvider`) faz fallback do alias `'haiku'` para o modelo do pai. Ou seja: se você está em OpenRouter+Opus sem override, o WebResearcher também roda em Opus — anulando a economia.

**Solução**: defina um override explícito em `~/.claudio/settings.json`:

Adicione em `~/.claudio/settings.json`:

```json
{
  "agentModelOverrides": {
    "built-in:WebResearcher": "deepseek-chat"
  }
}
```

Ou qualquer outro modelo do seu provider ativo. A resolução é feita por `src/tools/AgentTool/agentModelResolver.ts` — sem código novo necessário.

## Override por custom agent

Se você criar um agent em `.claudio/agents/WebResearcher.md` (mesmo `agentType`), ele **sobrescreve** o built-in. Isso é feature, não bug: a ordem de merge em `loadAgentsDir.ts:207-211` é `built-in → plugin → userSettings → projectSettings → flagSettings → policySettings`, com cada fonte sobrepondo a anterior. Útil para customizar o system prompt sem fork.

## Indisponibilidade em `COORDINATOR_MODE`

Quando o build tem a flag `COORDINATOR_MODE` ligada **e** `CLAUDE_CODE_COORDINATOR_MODE` está truthy no ambiente, `getBuiltInAgents()` retorna apenas o conjunto de agents do coordenador (`builtInAgents.ts:34-42`) e o `WebResearcher` não fica disponível. O pai precisa cair em `WebFetch`/`WebSearch` diretos nesse modo.

## WebResearcherManager — orquestrador de deep-research

**Status:** Implementado (2026-06-01)
**Arquivos:** `src/tools/AgentTool/built-in/webResearcherManagerAgent.ts`

`WebResearcherManager` é uma camada **por cima** do `WebResearcher`: um agente built-in (modelo `'sonnet'`) que pega numa pergunta, a decompõe em 3–4 ângulos, faz **fan-out de `WebResearcher` workers em paralelo** (um por ângulo), **verifica as claims de forma cética**, e sintetiza **um único relatório citado com níveis de confiança**. Tudo isolado: o pai vê só o relatório final.

### Por que é o primeiro built-in que spawna sub-agentes

É deliberado. Até agora nenhum built-in chamava `AgentTool` — os sub-agentes eram folhas. O manager precisa orquestrar, então **declara `Agent(WebResearcher)`** na sua allowlist. Para isso funcionar foi preciso um ajuste mínimo em `resolveAgentTools` (`agentToolUtils.ts`):

- Sub-agentes normalmente só **registam** o spec do `Agent` para metadata (`allowedAgentTypes`); o tool em si é removido pelo `filterToolsForAgent` como guarda de recursão.
- **Exceção:** um orquestrador **sync + built-in** mantém o `Agent` resolvido (cai no caminho `isSyncBuiltInOrchestrator`), podendo fazer fan-out para os seus `allowedAgentTypes`.
- **Async e custom/plugin continuam bloqueados** — a recursão arbitrária não é permitida.

> **Nota de degradação (flag-gated).** O caminho de orquestrador depende de o manager correr **sync**. Se a flag de build `FORK_SUBAGENT` for ligada (hoje `false`), `forceAsync` torna todos os spawns async → `filterToolsForAgent` remove o `Agent` → o manager perde silenciosamente a capacidade de fan-out e degrada para um agente só-fetch (sem erro). Não escala privilégios — só degrada. Se reativares fork mode, valida este agente.

**A restrição de spawn é mesmo aplicada (não cosmética).** O `allowedAgentTypes` resolvido (`['WebResearcher']`) é propagado para o contexto do filho em `runAgent.ts` (campo `agentDefinitions.allowedAgentTypes`), e o `AgentTool` filtra os agentes spawnáveis por esse conjunto (`AgentTool.tsx`, filtro `allowedAgentTypes.includes(a.agentType)`). Sem esse threading, o spec seria descartado e o manager poderia spawnar **qualquer** agente — incluindo `general-purpose` (com shell/edit) ou outro `WebResearcherManager` (recursão ilimitada). Com ele, o manager só pode spawnar `WebResearcher`, e o `WebResearcher` não tem `Agent` tool — logo a profundidade é **hard-capped em 2**.

### Manager (Sonnet) vs. Worker (Haiku)

| Camada | Modelo | Papel |
|---|---|---|
| `WebResearcherManager` | `'sonnet'` | Decompor, delegar, **verificação adversarial**, síntese — o raciocínio caro |
| `WebResearcher` (×N) | `'haiku'` | Browsing mecânico por ângulo — barato, em paralelo |

A verificação é **baseada em raciocínio**, não um tally determinístico de N-votos como o harness `Workflow` faria. O prompt é explícito em não apresentar palpites como verificados. Quando/se o `WorkflowTool` deixar de ser stub, vale migrar a orquestração para lá.

### Quando o pai escolhe Manager vs. WebResearcher direto

| Cenário | Escolha |
|---|---|
| Pesquisa multi-ângulo que precisa de fact-check / confiança | `Agent(WebResearcherManager)` |
| Pesquisa multi-página simples (3+ fetches, um tópico) | `Agent(WebResearcher)` |
| URL específica / descoberta de links | `WebFetch` / `WebSearch` diretos |

### Override de modelo

Mesma mecânica do `WebResearcher` (ver acima): em providers non-Anthropic o alias `'sonnet'` faz fallback para o modelo do pai. Override via `~/.claudio/settings.json` → `agentModelOverrides["built-in:WebResearcherManager"]`.

> **Atenção (importante para este agente).** Em providers que passam pelo `openaiShim` (OpenRouter, Gemini, DeepSeek, Mistral, etc.), **ambos** os aliases `'sonnet'` (manager) e `'haiku'` (workers) fazem fallback para o modelo do pai. Isso **anula a assimetria de custo** que justifica este agente — manager e workers passam a correr todos no mesmo modelo. Se usas um provider OpenAI-shim, define overrides explícitos para `built-in:WebResearcherManager` e `built-in:WebResearcher` apontando para modelos de tiers diferentes do teu provider, ou o split Sonnet/Haiku não acontece.

### Trade-offs específicos do Manager

- **Custo/latência maior**: até 4 workers + verificação. Mitigado por cap de ângulos no prompt (≤4) e por a verificação ser inline no manager, não uma 3ª camada de agentes.
- **Indisponível em `COORDINATOR_MODE`**: mesmo motivo que o `WebResearcher`.

## Trade-offs aceitos

- **Latência extra**: queries que dariam 1–2 fetches diretos pagam o overhead de um round-trip de subagent. Mitigação: `whenToUse` explícito sobre quando NÃO usar.
- **Síntese pode perder nuance**: o pai não vê o HTML cru. Se precisar, pode fazer um `WebFetch` direto de uma URL específica que o filho citou.
- **Sem MCP, sem leitura local**: allowlist explícita exclui ambos. Para cruzar web com docs internos (Notion, repo, etc.), o pai faz isso antes/depois — não dentro do `WebResearcher`.
- **Sem feature flag**: não dá pra desligar em build se aparecer problema; reverter via PR. Aceito pela simplicidade.

## Como testar manualmente

```bash
bun run build && bun run dev
```

No REPL, peça algo que naturalmente requer multi-page research:

> pesquise na web como configurar OAuth device flow no GitHub Copilot CLI provider

Espere:

- O pai chamar `Agent(subagent_type='WebResearcher')`.
- Várias `WebFetch`/`WebSearch` rodando **dentro** do subagent (sem aparecer no histórico do pai).
- A resposta final no pai conter URLs citadas em markdown, sem HTML cru.

## Referências de código

- Implementação: `src/tools/AgentTool/built-in/webResearcherAgent.ts`
- Testes: `src/tools/AgentTool/built-in/webResearcherAgent.test.ts`
- Registro: `src/tools/AgentTool/builtInAgents.ts`
- Infra de subagents: `src/tools/AgentTool/loadAgentsDir.ts` (shape), `src/tools/AgentTool/agentToolUtils.ts` (`resolveAgentTools`)
- Descoberta pelo pai: `src/tools/AgentTool/prompt.ts:41-74`
- Override de modelo: `src/tools/AgentTool/agentModelResolver.ts`, `src/tools/AgentTool/builtInModelOverrides.ts`
