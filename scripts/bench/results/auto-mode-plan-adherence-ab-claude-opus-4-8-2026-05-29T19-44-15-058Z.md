# Bench A/B — auto-mode plan adherence

- Timestamp: 2026-05-29T19:44:15.058Z
- Model: `claude-opus-4-8`
- Baseline: `dist-baseline/cli.mjs`
- Feature:  `/home/dev/projects/claudio/dist/cli.mjs`
- Runs por prompt: 3

## Tabela por invocacao

| Prompt | Kind | V | Run | OK | PlanMode | Tokens in/out/cache_read | Cost $ | Wall (s) | Turns | Tool calls | Session |
|---|---|---|---:|:-:|:-:|---|---:|---:|---:|---|---|
| implicit-howwould | plan | A | 1 | N | no | 4/520/83563 | 0.2103 | 10.4 | 3 | EnterPlanMode=0 Bash=0 Read=3 Grep=0 Glob=1 | bd25a691 |
| implicit-howwould | plan | B | 1 | N | YES | 4/274/83896 | 0.1977 | 8.3 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | cc649fad |
| implicit-approach-first | plan | A | 1 | N | no | 4/908/83565 | 0.2085 | 15.6 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=1 | d96ae272 |
| implicit-approach-first | plan | B | 1 | N | YES | 4/682/83898 | 0.2090 | 11.5 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | ab1e6b31 |
| implicit-think | plan | A | 1 | N | no | 1764/809/83568 | 0.2141 | 14.2 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=2 Glob=0 | 50bd735a |
| implicit-think | plan | B | 1 | N | YES | 4/570/83901 | 0.2058 | 11.7 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=1 Glob=0 | 9bf9bd3e |
| explicit-sanity | plan | A | 1 | N | YES | 4/240/83562 | 0.1948 | 6.5 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | b3d23039 |
| explicit-sanity | plan | B | 1 | N | YES | 4/292/83895 | 0.1983 | 7.2 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | 2678f878 |
| control-direct-action | control | A | 1 | N | no | 4/1037/83560 | 0.2170 | 18.1 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | 8ffee8d6 |
| control-direct-action | control | B | 1 | N | no | 4/1277/83893 | 0.2245 | 21.3 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | bd5d5d46 |
| control-howworks | control | A | 1 | N | no | 4/272/83559 | 0.1885 | 8.6 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=1 | fd91bc3d |
| control-howworks | control | B | 1 | N | no | 4/219/83892 | 0.1890 | 6.4 | 3 | EnterPlanMode=0 Bash=0 Read=0 Grep=0 Glob=2 | 4185b01a |
| implicit-howwould | plan | A | 2 | N | no | 4/517/105260 | 0.0809 | 11.0 | 3 | EnterPlanMode=0 Bash=0 Read=3 Grep=0 Glob=1 | 7f5ad345 |
| implicit-howwould | plan | B | 2 | N | YES | 4/273/105926 | 0.0711 | 7.4 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | 3f01416f |
| implicit-approach-first | plan | A | 2 | N | no | 4/1327/105264 | 0.1039 | 21.0 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=1 Glob=2 | 3d86fa0f |
| implicit-approach-first | plan | B | 2 | N | YES | 4/552/105930 | 0.0789 | 10.6 | 3 | EnterPlanMode=1 Bash=0 Read=0 Grep=0 Glob=1 | dae4881e |
| implicit-think | plan | A | 2 | N | no | 462/746/105270 | 0.0871 | 11.4 | 3 | EnterPlanMode=0 Bash=0 Read=2 Grep=2 Glob=0 | ab3be199 |
| implicit-think | plan | B | 2 | N | no | 0/0/0 | 0.0000 | 204.9 | 1 | EnterPlanMode=0 Bash=0 Read=0 Grep=0 Glob=0 | e392b66a |
| explicit-sanity | plan | A | 2 | N | YES | 2121/34569/73980 | 3.0850 | 438.1 | 3 | EnterPlanMode=1 Bash=9 Read=11 Grep=2 Glob=7 other=5 | 225c096e |
| explicit-sanity | plan | B | 2 | N | YES | 4/304/83895 | 0.1984 | 7.3 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | b4fe0087 |
| control-direct-action | control | A | 2 | N | no | 4/1406/83560 | 0.2261 | 22.3 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | 6994d26c |
| control-direct-action | control | B | 2 | N | no | 4/776/83893 | 0.2123 | 14.9 | 3 | EnterPlanMode=0 Bash=1 Read=1 Grep=0 Glob=0 | 939f91a2 |
| control-howworks | control | A | 2 | N | no | 4/354/83559 | 0.1902 | 9.0 | 3 | EnterPlanMode=0 Bash=0 Read=0 Grep=1 Glob=2 | cd38986d |
| control-howworks | control | B | 2 | N | no | 4/224/83892 | 0.1891 | 6.6 | 3 | EnterPlanMode=0 Bash=0 Read=0 Grep=0 Glob=2 | 54d1e31e |
| implicit-howwould | plan | A | 3 | N | no | 4/696/83563 | 0.2106 | 14.4 | 3 | EnterPlanMode=0 Bash=0 Read=4 Grep=0 Glob=1 | 18baeb91 |
| implicit-howwould | plan | B | 3 | N | YES | 4/235/83896 | 0.1969 | 6.9 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=0 | 2526615a |
| implicit-approach-first | plan | A | 3 | N | no | 1340/1452/83565 | 0.2319 | 23.2 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=3 Glob=1 | 887b6afc |
| implicit-approach-first | plan | B | 3 | N | YES | 4/682/83898 | 0.2097 | 14.9 | 3 | EnterPlanMode=1 Bash=0 Read=0 Grep=0 Glob=1 | 68284ec6 |
| implicit-think | plan | A | 3 | N | no | 462/815/83568 | 0.2135 | 12.1 | 3 | EnterPlanMode=0 Bash=0 Read=2 Grep=2 Glob=0 | 6ffa6a47 |
| implicit-think | plan | B | 3 | N | YES | 4/773/83901 | 0.2120 | 12.9 | 3 | EnterPlanMode=1 Bash=0 Read=0 Grep=2 Glob=0 | a8c63a37 |
| explicit-sanity | plan | A | 3 | N | no | 4/648/83562 | 0.2091 | 11.7 | 3 | EnterPlanMode=0 Bash=0 Read=4 Grep=0 Glob=1 | 629ca5ed |
| explicit-sanity | plan | B | 3 | N | YES | 4/254/105924 | 0.0705 | 6.5 | 3 | EnterPlanMode=1 Bash=0 Read=1 Grep=0 Glob=1 | d26af916 |
| control-direct-action | control | A | 3 | N | no | 4/1341/105254 | 0.0993 | 25.0 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | 01a900f0 |
| control-direct-action | control | B | 3 | N | no | 4/1300/105920 | 0.0989 | 21.9 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=0 other=1 | 471ef414 |
| control-howworks | control | A | 3 | N | no | 4/283/105252 | 0.0641 | 7.7 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=0 Glob=1 | c0dd12e4 |
| control-howworks | control | B | 3 | N | no | 4/281/105918 | 0.0631 | 7.4 | 3 | EnterPlanMode=0 Bash=0 Read=1 Grep=1 Glob=0 | cc5b419d |

## KPI — taxa de plan mode

| Subconjunto | A (baseline) | B (feature) | Delta (pp) |
|---|---|---|---:|
| plan-* | 2/12 (17%) | 11/12 (92%) | 75 |
| control-* | 0/6 (0%) | 0/6 (0%) | 0 |

### Por prompt (plan rate A -> B)

- **implicit-howwould** (plan): 0/3 (0%) -> 3/3 (100%)
- **implicit-approach-first** (plan): 0/3 (0%) -> 3/3 (100%)
- **implicit-think** (plan): 0/3 (0%) -> 2/3 (67%)
- **explicit-sanity** (plan): 2/3 (67%) -> 3/3 (100%)
- **control-direct-action** (control): 0/3 (0%) -> 0/3 (0%)
- **control-howworks** (control): 0/3 (0%) -> 0/3 (0%)

## Custo (sanity)

- Avg cost A: $0.3353 | Avg cost B: $0.1570 | delta -53.2%

## Kill criteria

- SHIP se B plan-rate >=80% nos plan-* E (B-A) >= +25pp E control nao regride (B nao dispara plan no controle).
- KILL se B plan-rate <60% nos plan-* OU ganho <+15pp vs A (nudge inerte).

- Veredito: **SHIP candidate**
  - plan-rate B: 92% (ship>=80, kill<60)
  - delta B-A: 75pp (ship>=25, kill<15)
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

> adicione um console.log em src/utils/log.ts pra debugar

### control-howworks (control)

> como funciona o tratamento de erro do BashTool hoje?

