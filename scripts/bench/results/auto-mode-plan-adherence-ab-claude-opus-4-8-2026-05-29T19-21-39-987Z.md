# Bench A/B — auto-mode plan adherence

- Timestamp: 2026-05-29T19:21:39.987Z
- Model: `claude-opus-4-8`
- Baseline: `dist-baseline/cli.mjs`
- Feature:  `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3

## Tabela por invocacao

| Prompt | Kind | V | Run | OK | PlanMode | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Session |
|---|---|---|---:|:-:|:-:|---|---:|---:|---:|---|---|
| implicit-howwould | plan | A | 1 | N | no | 4/579/52574 | 0.3894 | 12.0 | 3 | EnterPlanMode=0 Bash=0 Read=2 Grep=1 Glob=1 | fa797ff6 |
| implicit-howwould | plan | B | 1 | N | no | 4/852/83716 | 0.2155 | 14.1 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=2 Glob=2 | 3739aa44 |
| implicit-approach-first | plan | A | 1 | N | no | 4/803/83509 | 0.2038 | 14.1 | 3 | EnterPlanMode=0 Bash=0 Read=0 Grep=1 Glob=2 | 1d2fa04f |
| implicit-approach-first | plan | B | 1 | N | YES | 4/653/83718 | 0.2068 | 12.3 | 3 | EnterPlanMode=1 Bash=0 Read=0 Grep=1 Glob=1 | 96654ce6 |
| implicit-think | plan | A | 1 | N | no | 1764/616/83512 | 0.2083 | 11.9 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=2 Glob=0 | 4976ab58 |
| implicit-think | plan | B | 1 | N | YES | 4/816/83721 | 0.2115 | 14.0 | 3 | EnterPlanMode=1 Bash=0 Read=0 Grep=2 Glob=0 | 9d4ae27f |
| explicit-sanity | plan | A | 1 | N | YES | 4/223/83506 | 0.1939 | 8.5 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | f6b414a6 |
| explicit-sanity | plan | B | 1 | N | YES | 4/252/83715 | 0.1962 | 7.4 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | d9a1196e |
| control-direct-action | control | A | 1 | Y | no | 4/817/83504 | 0.2111 | 16.0 | 2 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 | d7d66db8 |
| control-direct-action | control | B | 1 | N | no | 4/1197/83713 | 0.2223 | 22.0 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | e273757d |
| implicit-howwould | plan | A | 2 | N | no | 4/579/105148 | 0.0838 | 11.1 | 3 | EnterPlanMode=0 Bash=0 Read=3 Grep=0 Glob=2 | 3e82d5a1 |
| implicit-howwould | plan | B | 2 | N | no | 4/788/105566 | 0.0890 | 14.2 | 3 | EnterPlanMode=0 Bash=0 Read=4 Grep=0 Glob=1 | b2f259dd |
| implicit-approach-first | plan | A | 2 | N | no | 4/843/105152 | 0.0814 | 16.1 | 3 | EnterPlanMode=0 Bash=0 Read=0 Grep=0 Glob=2 | 44b28356 |
| implicit-approach-first | plan | B | 2 | N | YES | 4/666/105570 | 0.0814 | 12.3 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | 00e077e1 |
| implicit-think | plan | A | 2 | N | no | 4/425/105158 | 0.0658 | 10.0 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=1 Glob=0 | 1dd64f93 |
| implicit-think | plan | B | 2 | N | no | 9161/9356/497370 | 0.9270 | 135.0 | 3 | EnterPlanMode=0 Bash=0 Read=0 Grep=0 Glob=0 other=2 | 6d338b53 |
| explicit-sanity | plan | A | 2 | N | YES | 4/224/105146 | 0.0695 | 7.6 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | 9da8d5ce |
| explicit-sanity | plan | B | 2 | N | YES | 4/219/105564 | 0.0696 | 6.7 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | ea9e32c1 |
| control-direct-action | control | A | 2 | N | no | 4/609/105142 | 0.0809 | 12.1 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=1 Glob=0 | 768c1b05 |
| control-direct-action | control | B | 2 | N | no | 4/1168/105560 | 0.0953 | 21.0 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | b989911c |
| implicit-howwould | plan | A | 3 | N | no | 4/576/105148 | 0.0825 | 11.4 | 3 | EnterPlanMode=0 Bash=0 Read=3 Grep=0 Glob=1 | fb3182a5 |
| implicit-howwould | plan | B | 3 | N | no | 4/902/105566 | 0.0975 | 15.5 | 3 | EnterPlanMode=0 Bash=0 Read=2 Grep=1 Glob=1 | 473e7d69 |
| implicit-approach-first | plan | A | 3 | N | no | 4/1317/105152 | 0.1033 | 19.7 | 3 | EnterPlanMode=0 Bash=0 Read=2 Grep=1 Glob=1 | 3d035c7c |
| implicit-approach-first | plan | B | 3 | N | YES | 4/499/105570 | 0.0767 | 9.4 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | e3149fc3 |
| implicit-think | plan | A | 3 | N | no | 1764/850/105158 | 0.0864 | 13.6 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=3 Glob=0 | ecc2d6cf |
| implicit-think | plan | B | 3 | N | no | 8174/10288/686994 | 0.9796 | 150.8 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=2 | 62bfc4f3 |
| explicit-sanity | plan | A | 3 | N | YES | 4/284/105146 | 0.0711 | 6.8 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | 14cc0e5b |
| explicit-sanity | plan | B | 3 | N | YES | 4/230/105564 | 0.0699 | 7.0 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | 2c3ce57a |
| control-direct-action | control | A | 3 | N | no | 4/763/105142 | 0.0854 | 14.2 | 3 | EnterPlanMode=0 Bash=1 Read=1 Grep=0 Glob=0 | fd69e3f4 |
| control-direct-action | control | B | 3 | N | no | 4/952/105560 | 0.0894 | 15.6 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | 57848027 |

## KPI — taxa de plan mode

| Subconjunto | A (baseline) | B (feature) | Delta (pp) |
|---|---|---|---:|
| plan-* | 3/12 (25%) | 7/12 (58%) | 33 |
| control-* | 0/3 (0%) | 0/3 (0%) | 0 |

### Por prompt (plan rate A -> B)

- **implicit-howwould** (plan): 0/3 (0%) -> 0/3 (0%)
- **implicit-approach-first** (plan): 0/3 (0%) -> 3/3 (100%)
- **implicit-think** (plan): 0/3 (0%) -> 1/3 (33%)
- **explicit-sanity** (plan): 3/3 (100%) -> 3/3 (100%)
- **control-direct-action** (control): 0/3 (0%) -> 0/3 (0%)

## Custo (sanity)

- Avg cost A: $0.2111 | Avg cost B: $0.0000 | delta -100.0%

## Kill criteria

- SHIP se B plan-rate >=80% nos plan-* E (B-A) >= +25pp E control nao regride (B nao dispara plan no controle).
- KILL se B plan-rate <60% nos plan-* OU ganho <+15pp vs A (nudge inerte).

- Veredito: **INERT/REVERT**
  - plan-rate B: 58% (ship>=80, kill<60)
  - delta B-A: 33pp (ship>=25, kill<15)
  - control B: 0% (nao deve subir vs A=0%)

## Outputs (resultText) lado a lado

### implicit-howwould (plan)

> como voce faria pra adicionar um novo slash command /foo neste repo?

### implicit-approach-first (plan)

> me explica a abordagem antes de mexer no tratamento de erro do BashTool

### implicit-think (plan)

> vamos pensar em como adicionar suporte a um novo provider OpenAI-compativel

### explicit-sanity (plan)

> vamos planejar como adicionar um novo slash command /bar neste repo

### control-direct-action (control)

> adicione um console.log em src/shared/log.ts pra debugar

**Variant A run#1** (plan=no):

```
Duas questões antes de mexer:

1. **`console.log` é anti-pattern aqui** — a regra do projeto (`typescript-patterns.md`) diz que `console.log` polui o TUI; o caminho certo é `logForDebugging()`, que inclusive já está importado nesse arquivo (`src/shared/log.ts:20`). Ele só emite quando o debug está ligado, então não suja a saída normal.

2. **O que você quer debugar?** O arquivo tem várias funções (`getLogDisplayTitle`, `logError`, `logMCPDebug`, `captureAPIRequest`...). Preciso saber qual ponto/variável inspecionar pra colocar o log no lugar útil.

Me diz o que quer rastrear que eu adiciono um `logForDebugging('...')` no ponto certo. Se você realmente precisa de `console.log` cru (ex: script isolado fora do TUI), me confirma que aí eu coloco mesmo assim.
```

