# Technical Design Docs

Pasta para documentos técnicos de **arquitetura e implementação** de features do claudin. Diferente de `docs/archive/discovery/` (que mapeia o problema e valida estratégias), aqui mora **a solução**.

## Estrutura

```
docs/tech/
└── <feature>/
    ├── README.md          # overview + status + decisões chave
    └── architecture.md    # design técnico detalhado
```

## Features

| Feature | Status | Discovery |
|---|---|---|
| [`bash-output-filter/`](bash-output-filter/) | Em design | [`docs/archive/discovery/bash-output-filter/`](../archive/discovery/bash-output-filter/) |
| [`web-researcher/`](web-researcher/) | Implementado (2026-05-16) | — |
| [`repo-map/`](repo-map/) | Avaliado e medido (2026-08-16) — algoritmo v1 rejeitado, uma lane sobrevive atrás de flag | probe em [`scripts/bench/repomap/`](../../scripts/bench/repomap/) |
