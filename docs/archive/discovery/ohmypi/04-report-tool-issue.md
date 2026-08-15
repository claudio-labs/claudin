# 04 — `report_tool_issue` (self-feedback)

## O que omp faz

Uma tool meta exposta para o modelo, com `tool` parametrizado como `z.enum([...tools-ativos-no-turno])`. Quando uma tool falha de forma estranha ou tem descrição confusa, o modelo pode chamar `report_tool_issue({ tool: "...", category: "...", description: "..." })` e isso vira artefato estruturado.

Vira loop de QA: o agente sinaliza pontos cegos da própria spec.

## Por que importa para Claudin

- Claudin já tem memory system (`feedback`, `project`) e `MEMORY.md` indexes.
- Hoje o feedback flui só do usuário humano → assistant. O modelo nunca registra "tool X tem descrição ambígua que me fez errar".
- Combinaria com `bashOutputFilterEnabled` debugging — modelo poderia reportar quando filtro escondeu sinal.
- Output natural: append em `~/.claudin/projects/<dir>/memory/tool-issues.md` ou JSONL para análise offline.

## Perguntas em aberto

- Risco de o modelo gastar tool calls reclamando? Rate limit? Só ativar com flag?
- Categorias: `unclear_description | wrong_schema | unexpected_output | missing_param | other`?
- Vai para memory team-scoped ou private?
- Como o desenvolvedor humano consome (CLI tipo `claudin tool-issues --since 7d`)?

## Referência

- omp tool registry (procurar `report_tool_issue`)
- `src/memory/memdir/` (claudin)
