# 07-gap — AST/code-intelligence além do AstEdit

> Insight, deep e fit cobriram só `ast-edit`/`Replace`. Aqui o resto.

## 1. Resumo dos novos sistemas omp

| Sistema | Arquivos (omp) | Faz |
|---|---|---|
| **Structural summary / elision** | `crates/pi-ast/src/summary.rs:1-1044`, `crates/pi-natives/src/summary.rs:1-80`, `packages/coding-agent/src/tools/read.ts:1335-1457` | Dobra bodies/comments/import-runs por AST. `min_body_lines`/`min_comment_lines` ajustáveis. 30+ linguagens com listas explícitas de `is_elidable_kind`/`is_comment_kind`/`is_groupable_kind`. Aplicado no Read tool com fallback footer "read X:raw para verbatim". |
| **AstGrep separado** | `packages/coding-agent/src/tools/ast-grep.ts:35-285`, `prompts/tools/ast-grep.md:1-43` | Tool dedicado de busca AST (sem edit). Paginação `skip`/`limit`, `parseErrors`, `meta_variables` por match. Multi-target glob com rebase de paths. |
| **MatchStrictness 6 níveis** | `crates/pi-ast/src/ops.rs:15-36`, `crates/pi-natives/src/ast.rs:20-55` | `Cst|Smart|Ast|Relaxed|Signature|Template` controla tolerância sintática do match. Default = Smart. |
| **Selector contextual** | `crates/pi-ast/src/ops.rs:97-111`, `:275-281` | `Pattern::contextual(pattern, selector, lang)` — embrulha snippet em contexto válido (truque `fn __rwp_wrapper() { … }` para Rust). Resolve "pattern não parseia standalone". |
| **Safety caps em edit** | `crates/pi-natives/src/ast.rs:148-154` | `dry_run` default-on, `max_replacements`, `max_files`, `fail_on_parse_error`. Cap independente do prompt. |
| **Diff preview material** | `crates/pi-natives/src/ast.rs:163-195` (`AstReplaceChange`, `AstReplaceFileChange`) | Cada edit retorna before/after + byte range + line/col. Permite UI de "blast radius" antes de aplicar. |
| **parse_errors não-fatal** | `crates/pi-natives/src/ast.rs:128`, `:215` | Erros de parse propagam como campo de resultado, não exception. Modelo aprende a reescrever pattern. |
| **`apply_edits` com detecção de overlap** | `crates/pi-ast/src/ops.rs:187-212` | Sort + reverse + reject overlapping edits — "refine pattern to avoid ambiguous edits". |
| **Token counting** | `crates/pi-natives/src/tokens.rs:1-65` | tiktoken-rs (o200k/cl100k) em rayon paralelo. Não AST mas é code-intel adjacente — orçamento de contexto exato. |
| **LSP tool completo** | `packages/coding-agent/src/prompts/tools/lsp.md:1-30` | `diagnostics`, `definition`, `type_definition`, `implementation`, `references`, `hover`, `symbols`, `rename`, `rename_file` (com `workspace/willRenameFiles`), `code_actions` (list/apply), `status`, `capabilities`, `request` (raw — `rust-analyzer/expandMacro`, `typescript/goToSourceDefinition`, `workspace/executeCommand`), `reload`. Símbolo via `symbol: "foo#2"` (Nth ocorrência na linha). |

Não encontrado em omp: AST diff/merge, dead-code analyzer, complexity metrics, formatter via AST, codemod recipe library (recipe/ existe mas é runner de shell scripts, não codemods), lint integration dedicada (lint vem via `lsp diagnostics`).

## 2. Vale pra Claudin?

| Sistema | Vale? | Razão |
|---|---|---|
| **Structural summary no FileReadTool** | **Sim, alto valor** | Read hoje devolve arquivo inteiro até `MAX_OUTPUT_CHARS`. Dobrar bodies grandes (>4 linhas) economiza tokens em arquivos como `src/services/api/openaiShim.ts` (~2.2k linhas, citado em CLAUDE.md). Independente do FileEditTool — não introduz tool novo, só enriquece Read. Maior ROI da lista. |
| **AstGrep como busca** | **Talvez** | GrepTool (ripgrep) cobre 95% das buscas. AstGrep só ganha quando "shape" importa (calls, decls). Mas omp manteve os dois separados — sinal de que coexistem bem. Custo: mesmo pipeline WASM do AstEdit, então piggyback no mesmo investimento. |
| **MatchStrictness 6-níveis** | Só se AstEdit existir | Detalhe interno. Default Smart resolve. Expor no schema do tool inflaria sem ganho mensurável. |
| **Selector contextual** | Sim, se AstEdit existir | Truque do `fn __rwp_wrapper` é a diferença entre "pattern não compila" e "funciona". Sem isso AstEdit fica frágil em Rust/TS. |
| **dry_run / max_replacements / max_files** | Sim, obrigatório se AstEdit | Caps anti-pé-no-chão. omp default-on em `dry_run` é a postura certa pra um agent. |
| **fail_on_parse_error flag** | Sim | Política explícita ao invés de mascarar. |
| **AstReplaceChange diff preview** | Sim | UI da Claudin já tem diff renderer (FileEditTool). Mesmo formato — encaixa direto. |
| **parse_errors campo** | Sim | Pattern do projeto: fallback pattern (typescript-patterns.md). Encaixa. |
| **Overlap detection** | Sim | Correção, não feature. |
| **Token counting (tiktoken)** | **Sim, ortogonal** | Claudin hoje estima tokens via heurística string-length em vários pontos. tiktoken via WASM (`@dqbd/tiktoken` ou similar — pure JS) daria budget exato. Não precisa pi-ast pra isso. Investigar separado. |
| **LSP rename / code_actions / request** | **Sim, prioridade > AstEdit** | LSPTool de Claudin (`src/tools/LSPTool/schemas.ts:14-166`) só tem read-ops (goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, callHierarchy). Não tem `rename`, `rename_file`, `code_actions`, `request` raw. O fit doc do AstEdit já notou (`fit:226-228`): "LSP rename já presente cobriria rename cross-file melhor que ast-grep". Adicionar essas ops no LSPTool ataca o mesmo caso de uso (rename amplo) sem WASM, sem tree-sitter, sem novo tool. |

## 3. Encaixe em Claudin

1. **FileReadTool + summary** — primeira porta. Não precisa do crate Rust: implementação em TS puro com `web-tree-sitter` (3 grammars) cabe em `src/tools/FileReadTool/summarize.ts`. Settings já existem em padrão omp (`read.summarize.minBodyLines`). Gate atrás de `feature('READ_AST_SUMMARY')` em `scripts/build.ts:featureFlags`. Footer "read X:1-9999 for raw" segue padrão dos guardrails de erro do FileEditTool.

2. **LSPTool write-ops** — `src/tools/LSPTool/schemas.ts`: adicionar `rename` (com preview/apply), `codeActions` (list/apply), `rawRequest` (foge da semântica tipada mas habilita `rust-analyzer/expandMacro` etc.). Reusa infra LSP existente. **Maior ROI/custo do gap inteiro** porque resolve o caso "rename amplo" sem WASM.

3. **AstEdit/AstGrep** — se forem feitos (ver veredito fit), copiar `MatchStrictness` enum, `dry_run` default-on, `max_*` caps, `parse_errors` field, `AstReplaceChange` shape. Não inventar API nova; o omp já depurou.

4. **Token counting tiktoken** — separado dos itens AST. Avaliar `js-tiktoken` ou `@dqbd/tiktoken` no `src/utils/tokens/` para substituir heurísticas de `src/utils/context*`.

Não encaixa em Claudin: recipe runner (omp = scripts shell, ortogonal), summary.rs cobertura de 30 linguagens (mirar 5: TS/JS/Python/Rust/Go), tree-sitter via NAPI (manter WASM coerente com "single-file bundle" promise do CLAUDE.md).
