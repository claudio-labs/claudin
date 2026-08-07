# Pesquisa de Mercado — Claude Code & opencode (maio/2026)

Análise de o que usuários querem, do que reclamam, e onde o Claudin (fork multi-provider) pode se destacar.

Fontes: Reddit (r/ClaudeAI, r/ClaudeCode, r/LocalLLaMA), Hacker News, GitHub issues (anthropics/claude-code, sst/opencode), blogs (Builder.io, MindStudio, The Register, claudefa.st), análises independentes (Stella Laurenzo / anthonymaio.substack.com), DEV.to.

---

## 1. Claude Code — Features mais pedidas

### 1.1 Limites semanais maiores / mais transparentes
Usuários Max ($100/$200) esgotam o cap semanal em 1,5–2 dias usando Opus 4.7. O anúncio de maio/2026 dobrou as janelas de 5h mas não mexeu no teto semanal. Hoje o pedido é "aumentem o balde semanal, não só a torneira."
Fontes: [r/ClaudeCode](https://www.reddit.com/r/ClaudeCode/), [Issue #41788](https://github.com/anthropics/claude-code/issues/41788), [Issue #38335](https://github.com/anthropics/claude-code/issues/38335), [The Register (31/mar/2026)](https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/), [claudefa.st](https://claudefa.st/blog/guide/development/higher-usage-limits).
**Severidade: queixa #1.**

### 1.2 Liberdade de provider / modelo
Pedido recorrente: trocar para GPT-5.3 / Codex / Qwen local quando o cap do Claude estoura, sem sair da harness. O CLI da Anthropic é travado em modelos Anthropic.
Fontes: [DEV.to (500+ devs)](https://dev.to/_46ea277e677b888e0cd13/claude-code-vs-codex-2026-what-500-reddit-developers-really-think-31pb), [Morph LLM](https://www.morphllm.com/comparisons/opencode-vs-claude-code).

### 1.3 Sessões remotas / always-on (parcialmente entregue)
"Quero iniciar uma tarefa e sair." Remote Control + Scheduled Tasks atenderam parte; ainda falta multi-usuário/multi-controller e uma UI remota mais rica.
Fonte: [MindStudio — roundup Q1/2026](https://www.mindstudio.ai/blog/claude-code-q1-2026-update-roundup).

### 1.4 Rubricas / Outcomes definidos pelo usuário
Outcomes traz um agente avaliador, mas o pessoal quer templates de rubrica próprios e bibliotecas por time.

### 1.5 Multi-sessão / troca de projeto no TUI
Usuários abrem vários terminais como gambiarra porque não existe nada built-in para manter sessões lado a lado.
Fonte: [Builder.io head-to-head](https://www.builder.io/blog/opencode-vs-claude-code).

### 1.6 PR review mais barato
Code Review é visto como caro demais para uso rotineiro; times querem default Haiku-class.

### 1.7 Controle de "extended thinking"
Análise de 6.852 sessões da Stella Laurenzo: profundidade caiu ~67% após mudança silenciosa de default em 04/mar. Pedido: controle por tarefa que sobreviva a updates.
Fonte: [anthonymaio.substack.com](https://anthonymaio.substack.com/p/codex-got-better-because-claude-code).

### 1.8 Viewer de transcript pré-compact
[Issue #27242](https://github.com/anthropics/claude-code/issues/27242): `transcript.jsonl` preserva o histórico completo, mas a TUI não tem viewer funcional. Issue com muitos comentários e reaberturas.

### 1.9 Budget de ferramentas / isolamento de MCP
Escopar MCP por slash-command para evitar o "imposto MCP" de 50K tokens por sessão. Tool Search ajudou (redução de 46,9%), mas ainda querem enable/disable seletivo em runtime.
Fontes: [Issue #3036](https://github.com/anthropics/claude-code/issues/3036), [unclog](https://github.com/thomaschill/unclog).

### 1.10 Image-paste / clipboard no Windows
Pedido repetido em ambos os tools.
Fonte: [Issue #4392](https://github.com/sst/opencode/issues/4392).

---

## 2. Claude Code — Bugs e dores

### 2.1 Regressão de medição de rate-limit
Usuários Max batendo 100% em 70 minutos. Anthropic reconheceu publicamente como "top priority".
Fontes: [#41424](https://github.com/anthropics/claude-code/issues/41424), [#38335](https://github.com/anthropics/claude-code/issues/38335), [The Register](https://www.theregister.com/2026/03/31/anthropic_claude_code_limits/).

### 2.2 Regressão de qualidade ("Claude ficou burro")
Forense de 6.852 sessões: read-to-edit caiu de 6,6 → 2,0; edits sem read prévio subiram de 6,2% → 33,7%; user interrupts por 1K tool calls subiu de 0,9 → 5,9. Postmortem da Anthropic confirmou três bugs simultâneos (raciocínio em 04/mar, caching em 26/mar, prompt-length cap em 16/abr), todos corrigidos até 20/abr.
Fontes: [anthonymaio.substack.com](https://anthonymaio.substack.com/p/codex-got-better-because-claude-code), [The Register (13/abr/2026)](https://www.theregister.com/2026/04/13/claude_outage_quality_complaints/).

### 2.3 Resume + auto-compact perdem contexto
Retomar sessão após auto-compact frequentemente apaga quase tudo; outras vezes diz "Context limit reached" com 26% livre.
Fontes: Issues #22107, #50732, #3138.

### 2.4 Subagents não invocam sub-subagents
OOM ou achatamento silencioso da árvore de agentes.
Fonte: [Issue #19077](https://github.com/anthropics/claude-code/issues/19077).

### 2.5 Fadiga de prompts de permissão
93% das aprovações são automáticas — segurança teatral. Auto Mode é restrito a Team/Enterprise.

### 2.6 Vazamento de código-fonte (mar/2026)
512k linhas publicadas no npm por `.npmignore` ausente. Revelou `undercover.ts` (anti-distilação com tools falsas) e DRM em Zig. Quebrou confiança.
Fonte: [HN](https://news.ycombinator.com/item?id=47586778).

### 2.7 Bloqueio OAuth (09/jan/2026)
Quebrou opencode, Cline e RooCode da noite pro dia. Reacendeu o medo de vendor lock-in.
Fonte: [thenewstack.io](https://thenewstack.io/anthropic-claudecode-opencode-split/).

---

## 3. opencode — Features mais pedidas

### 3.1 Multi-session / abas de sessão no TUI
Mesma dor do Claude Code, ainda mais crítica em opencode.
Fonte: [Issue #12548](https://github.com/sst/opencode/issues/12548).

### 3.2 Project switcher
Pular entre projetos recentes com restauração de memória.
Fonte: [Issue #14406](https://github.com/sst/opencode/issues/14406).

### 3.3 Image paste no Windows
[Issue #4392](https://github.com/sst/opencode/issues/4392) — também afeta colar do clipboard em geral.

### 3.4 Hooks de eventos completos
Cobertura para task start/finish/error, tool pre/post, confirmação, compactação, resume.

### 3.5 Auto Mode / classificador de risco
Querem o equivalente ao Auto Mode do Claude Code, sem gate de Team/Enterprise.

---

## 4. opencode — Bugs e dores

### 4.1 Regressões de TUI após v1.0
Input travado, scroll quebrado, releases inteiras quebradas.
Fontes: Issues #3488, #3541, #4026.

### 4.2 Plan Mode modificando arquivos
[Issue #5475](https://github.com/sst/opencode/issues/5475): chegou a editar arquivos em modo de planejamento. Corrigido, mas manchou reputação.

### 4.3 Windows é cidadão de segunda classe
Bun segfaulta, `rg`/`pwd` falham, install não roda em PowerShell, image paste ausente.

### 4.4 Tiers Black/Zen percebidos como "imposto"
Resposta ao bloqueio OAuth de jan/2026 não agradou; usuários veem como vendor lock-in invertido.

### 4.5 Provider switching exige restart
Trocar provider em runtime quebra. Workflow comum de "fallback quando o cap estoura" não funciona.

### 4.6 Qwen3-Coder local funciona, mas com pegadinhas
Precisa aumentar `num_ctx`, reiniciar após trocar provider, e escolher modelos com bom tool-calling. Documentação fraca sobre isso.

---

## 5. Temas transversais

| Tema | Comum aos dois? | Detalhes |
|---|---|---|
| Perda de contexto em sessões longas | Sim | Resume bugs no Claude Code; prompts congelados no opencode |
| Windows é segunda classe | Sim | Image paste, bash tools, ripgrep, install |
| Multi-sessão / abas ausentes | Sim | Workaround: múltiplos terminais |
| Subagents recursivos quebrados | Sim | Nenhum suporta planejamento recursivo robusto |
| Frustração de custo / cap | Sim | Cap semanal vs tiers Black |
| Lock-in de OAuth e risco de vendor | Sim | Incidentes de 09/jan e 21/abr |
| Descoberta de documentação | Sim | Config, providers, hooks |
| Pânico de regressão de qualidade | Sim | "Claude ficou burro" / "opencode quebra a cada release" |
| Fadiga de permission prompt | Sim | 93% rubber-stamp |
| Imposto MCP de tokens | Sim | ~50K tokens antes do 1º prompt com ~20 servers |

---

## 6. Oportunidades para o Claudin

1. **Escopo de MCP por comando** — frontmatter `mcp:` em markdown do comando.
2. **Contagem honesta de cap semanal + fallback de provider** — cap Anthropic estourou → Codex OAuth → Qwen local.
3. **Viewer de transcript pré-compact** — Issue #27242 ainda aberta; já preservamos `transcript.jsonl`.
4. **Resume que de fato funciona** — evitar bug de `tool_use_id` duplicado; teste de regressão dedicado.
5. **Auto Mode universal** — classificador com small-fast model, sem gate Team/Enterprise.
6. **Project switcher no TUI** — uma tecla entre projetos recentes, com restauração de memória.
7. **Abas multi-sessão** — porta direta do wishlist do opencode #12548.
8. **Preset air-gapped pronto** — Qwen3-Coder + 32K context + retries sãos, perfil de uma linha.
9. **Rubrica de custo por provider** — $/tokens por sessão por provider; cap "max session cost".
10. **Promessa "no-undercover-mode"** — diferencial pós-vazamento; `verify:privacy` já valida invariantes similares.
11. **Hooks em todos os eventos** — paridade com pedidos do opencode.
12. **Rubrica por comando (paridade com Outcomes)** — small-fast model avalia contra `.claudin/rubrics/<name>.md`.
13. **Bash output filter** — já shippado; ~50K tokens/sessão, ~72% redução de input cost. Vale destacar no marketing.
14. **Install Windows-first** — script PowerShell sem WSL, auto-ripgrep, image paste. Cobre opencode #4392.
15. **Página "O que forkamos, o que mudamos"** — moeda de confiança pós-vazamento.

---

## 7. Meta-tema

A corrida virou "qual a melhor harness em volta do modelo". Codex CLI venceu 65,3% vs 34,7% do Claude Code em pesquisa com 500+ devs ([DEV.to](https://dev.to/_46ea277e677b888e0cd13/claude-code-vs-codex-2026-what-500-reddit-developers-really-think-31pb)). Terreno fértil para um fork multi-provider que combine o melhor dos dois mundos sem o lock-in.
