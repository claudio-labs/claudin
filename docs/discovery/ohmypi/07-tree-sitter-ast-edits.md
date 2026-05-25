# 07 — Tree-sitter AST para FileEditTool

## O que omp faz

`crates/pi-natives/` empacota tree-sitter com 50+ grammars. Edits e refactors usam AST quando disponível, fallback para texto.

## Por que importa para Claudio

- `FileEditTool` hoje é match exato de string com replace_all opcional + sed-parser.
- Falha modos conhecidos:
  - Indentação misturada (já temos rule "always spaces" mas arquivo legado)
  - Aspas escapadas em strings
  - Múltiplas ocorrências quando só uma é alvo
- Com AST, edits poderiam ser:
  - "rename symbol `foo` no escopo X"
  - "substituir corpo da função `bar`"
  - "adicionar import"
- Tree-sitter via WASM (`web-tree-sitter`) evita virar polyglot. Bundle ~1MB por grammar, mas só carrega o necessário.

## Perguntas em aberto

- Lazy-load por extensão de arquivo?
- Tamanho do bundle final aceitável (CLAUDE.md fala em "single-file bundle")?
- Como expor isso ao modelo sem inchar schema? Nova tool `AstEditTool` ou param opcional do `FileEditTool`?
- Fallback determinístico quando grammar não disponível.
- Linguagens prioritárias: TS/JS, Python, Rust, Go, JSON, Markdown.

## Referência

- `crates/pi-natives/src/ast*` (omp)
- `src/tools/FileEditTool/` (claudio)
- https://github.com/tree-sitter/tree-sitter
