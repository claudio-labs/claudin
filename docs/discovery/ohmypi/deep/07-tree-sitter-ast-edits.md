# 07-deep — Tree-sitter AST edits: omp vs Claudin

> Aprofundamento do insight #7. Pesquisa, não implementação.

## Resumo executivo

- **omp** já roda em produção um par de tools complementares: `Replace` (string-edit clássico, fuzzy whitespace) e `AstEdit` (ast-grep nativo, codemods estruturais). As duas convivem; o prompt de `AstEdit` instrui explicitamente: *"For one-off local text edits, prefer the Edit tool."*
- O motor AST mora em Rust (`crates/pi-ast` + `crates/pi-natives/src/ast.rs`), exposto a TS via NAPI (`@oh-my-pi/pi-natives`). 55 grammars tree-sitter linkadas estaticamente no `.node`.
- **Claudin** só usa tree-sitter hoje para análise de segurança de Bash (`src/utils/bash/treeSitterAnalysis.ts`, via NAPI nativo). `FileEditTool` é 100% string match + normalização de aspas curvas + fuzzy whitespace via `findActualString` — nenhum AST.
- Conclusão pragmática: a posição correta para Claudin espelha omp — **adicionar um novo tool `AstEditTool` em vez de inflar `FileEditTool`**. Modelo continua escolhendo `Edit` para mudanças locais e `AstEdit` para codemods/refactors. Stack proposto: `web-tree-sitter` (WASM) com lazy-load por extensão, não napi.

---

## omp: como está construído

### Crates relevantes

- `/home/dev/projects/oh-my-pi/crates/pi-ast/` — lógica pura (sem napi). Wrappers de `ast-grep-core` + 55 grammars tree-sitter.
  - `src/language/parsers.rs:1-172` — uma `pub fn language_*() -> TSLanguage` por linguagem (astro, bash, c, clojure, cmake, cpp, c_sharp, dart, css, diff, dockerfile, elixir, erlang, go, graphql, haskell, hcl, html, ini, java, javascript, json, just, julia, kotlin, lua, make, md, nix, objc, ocaml, odin, perl, php, powershell, proto, python, r, regex, ruby, rust, scala, solidity, sql, starlark, svelte, swift, toml-ng, tlaplus, typescript, verilog, vue, xml, yaml, zig).
  - `src/language/mod.rs:1-789` — `SupportLang` enum, dispatch por extensão/alias, expando-char e `pre_process_pattern` para grammars que não aceitam `$` em identificador.
  - `src/ops.rs:127-212` — `compile_rewrite_rules`, `rewrite_source`, `apply_edits` (sort + reverse + reject overlaps). É aqui que `AstEdit` realmente roda.
- `/home/dev/projects/oh-my-pi/crates/pi-natives/src/ast.rs:1-1006` — camada NAPI. Define `AstFindOptions`, `AstReplaceOptions`, `AstReplaceResult`, e expõe duas funções `#[napi]`:
  - `ast_grep(options) -> Promise<AstFindResult>` (linhas 530-684)
  - `ast_edit(options) -> Promise<AstReplaceResult>` (linhas 686+)
- Bindings TS↔Rust: `napi-derive` gera `packages/natives/native/index.d.ts` (~45 KB) com `declare function astEdit(options)` etc. Consumido em TS como `import { astEdit } from "@oh-my-pi/pi-natives"`.

### Tool TS

- `packages/coding-agent/src/tools/ast-edit.ts:1-543` — `AstEditTool` (zod schema com `ops: [{pat, out}]` + `paths: string[]`).
- Prompt em `packages/coding-agent/src/prompts/tools/ast-edit.md:1-39` — descreve metavars (`$NAME`, `$$$ARGS`), regras de identidade do mesmo `$A` em dois lugares, e o critério de quando escolher cada tool.
- Coexiste com `Replace` (`prompts/tools/replace.md`) — params `{ path, edits[] }`, exigência de unicidade de `old_text`, `all: true` para multi-match. Quase o mesmo contrato do `FileEditTool` de Claudin.

### Custo no binário

- O `.node` é monolítico (não foi possível medir tamanho do artefato compilado neste checkout; só os `.d.ts`/`.js` gerados estão na árvore — 84K para o stub JS). Em distribuições omp publicadas, grammars estaticamente linkadas tipicamente custam ~200–500 KB compactadas por linguagem.

---

## Claudin: `FileEditTool` hoje

### Contrato

- Input (zod, `src/tools/FileEditTool/types.ts:6-19`): `{ file_path, old_string, new_string, replace_all?: boolean }`.
- Operação central (`FileEditTool.ts:330-356`):
  1. `findActualString(file, old_string)` — tolerância a aspas curvas/whitespace (`utils.ts`).
  2. Conta ocorrências por `split(actualOldString).length - 1`.
  3. Se >1 e `!replace_all`: erro `errorCode 9`. Senão: `replaceAll` ou `replace`.
- Pré-requisitos rigorosos:
  - Arquivo precisa ter sido lido antes (`readFileState`); erro `6` caso contrário.
  - mtime > timestamp do read ⇒ erro `7` ("File has been modified since read").
  - `.ipynb` ⇒ delega ao `NotebookEditTool`.
  - 1 GiB cap em `MAX_EDIT_FILE_SIZE` para evitar OOM.

### Modos de falha conhecidos (lidos no código, não em TODOs)

1. **Indentação misturada / whitespace fuzzy.** `findActualString` mascara whitespace differences, mas se old_string é colado da `Read` output o prefixo de número-de-linha pode contaminar (mitigado no prompt, não no código). Quebra ainda ocorre em arquivos com tabs+spaces misturados ou onde `Read` truncou linhas longas.
2. **Múltiplas ocorrências legítimas.** Caso o símbolo seja não-único e o usuário queira renomear *só uma definição* (ex.: variável local `i` em uma função entre dezenas), o modelo é forçado a inflar `old_string` com contexto até virar único — operação semanticamente AST disfarçada de texto.
3. **Aspas escapadas / template strings.** Normalização de aspas curvas (`LEFT_*_CURLY_QUOTE` → reta) só cobre Unicode quotes; backtick vs. `'` vs. `"` em mesma posição lógica permanece string-sensitive.
4. **`new_string === old_string`.** Bloqueado explicitamente (`errorCode 1`) — útil mas reduz ergonomia para refactors em que o modelo gera o mesmo texto por engano.
5. **Não há erro tipado para "encontrado mas em escopo errado".** O tool não sabe o que é "escopo".

### Cobertura de testes

- Apenas um `.test.ts`: `FileEditTool.diagnostics.test.ts`. Cobre o *contrato de injeção de diagnósticos LSP pós-edit* (linhas 1-60), não a lógica de match/edit. O próprio comentário do arquivo (linha 4-18) confirma: "We do NOT exercise FileEditTool.call directly here. Other LSP tests in the same shard globally mock fs and fs/promises, which leaks across files…".
- Lógica de match (replace_all, fuzzy whitespace, quote normalization, mtime-staleness) atualmente não tem teste unitário direto no diretório. As validações vivem por inspeção do `errorCode` retornado em integração — superfície coberta de fato pelos `bugfixes.test.ts` e suites E2E, não localmente.

### Tree-sitter atual em Claudin

- Já existe binding NAPI tree-sitter consumido em `src/utils/bash/treeSitterAnalysis.ts` e `src/tools/BashTool/bashSecurity.ts` (~10 referências). Usado *exclusivamente* para análise de segurança de comandos Bash — não para edição.
- Não há dependência `tree-sitter`/`web-tree-sitter` em `package.json`. O backend tree-sitter Bash atual vem provavelmente como native addon stubado (pre-scan do `scripts/build.ts` substitui imports ausentes).

---

## Proposta: `AstEditTool` (novo tool, não modificar `FileEditTool`)

### Por que tool separado

- **Schema discoverability.** Tools são vendidas ao modelo pelo schema + description. Adicionar `mode: "ast" | "text"` ao `FileEditTool` colide com `strict: true` (em `FileEditTool.ts:91`) e força o modelo a sempre decidir antes de saber se precisa.
- **Permissões diferentes.** AST-edit pode tocar múltiplos arquivos por chamada (`paths: string[]` em omp). O permission-matcher atual do `FileEditTool` (`preparePermissionMatcher` em `FileEditTool.ts:123-125`) é single-file. Mexer ali quebra `checkWritePermissionForTool`.
- **Padrão omp validado.** omp manteve `Replace` e `AstEdit` separados após uso real; cito de `replace.md`: *"For one-off local text edits, prefer the Edit tool."*
- **Fallback determinístico.** Quando grammar não disponível, AstEdit retorna erro estruturado e o modelo cai naturalmente em `Edit`. Misturados no mesmo tool, fallback vira lógica condicional escondida.

### Operações iniciais (MVP)

Convergir para 4 operações de alto valor, todas representáveis como ast-grep rewrite mas expostas com schemas semânticos amigáveis ao modelo:

1. `rename_symbol` — `{ file_path | paths[], old_name, new_name, kind?: "function" | "variable" | "class" | "type" }`. Internamente: pattern por kind do nó.
2. `replace_function_body` — `{ file_path, function_name, new_body }`. Pattern `function $function_name($$$ARGS) { $$$ }` ou `(method_definition name: (_) @n) @target`.
3. `add_import` — `{ file_path, import_statement, position?: "top" | "after_existing" }`. Para TS/Python.
4. `remove_import` — `{ file_path, symbol_or_module }`.

Operações que **não** entram no MVP: `move_function`, `extract_variable`, `inline_variable` — exigem renaming consistente e análise de escopo (LSP, não ast-grep).

### Linguagens MVP

- **TypeScript / TSX** — superfície primária do próprio repo Claudin (`src/**/*.ts`/`.tsx`); valida o tool em dogfood.
- **Python** — segunda linguagem mais comum em codebases de usuários; grammar estável.
- **JSON** — `add_import`/`remove_import` não se aplicam, mas `rename_symbol` (renomear key) e `replace_value` cobrem casos como `package.json`/configs.

Grammars deferidas: Rust, Go, Markdown (precisam ajuste de pattern strictness para falsos positivos baixos).

### Implementação: web-tree-sitter (WASM), não NAPI

**Motivos para escolher WASM em vez de NAPI nativo:**

1. **Single-file bundle.** CLAUDE.md exige bundle único `dist/cli.mjs`. NAPI addons quebram esse contrato (precisam de `.node` por plataforma + pre-builts). WASM é só um `.wasm` que pode ser embutido base64 ou carregado de `node_modules`.
2. **Cross-platform sem CI matrix.** WASM roda igual em macOS arm64, Linux x64, Windows. O Bash tree-sitter atual de Claudin já paga o custo de NAPI; adicionar mais não-Bash via NAPI multiplica esse custo.
3. **Lazy-load barato.** `Parser.Language.load('tree-sitter-typescript.wasm')` é chamado on-demand. Cold start do CLI não paga nada para tools que não rodam.

**Tamanho estimado (web-tree-sitter v0.25, dados públicos):**

- Runtime `web-tree-sitter.wasm`: ~250 KB (uma vez).
- `tree-sitter-typescript.wasm`: ~1.4 MB.
- `tree-sitter-python.wasm`: ~600 KB.
- `tree-sitter-json.wasm`: ~80 KB.

Total MVP descomprimido ~2.3 MB; gzip ~700 KB. Distribuído como arquivos separados em `dist/wasm/` (não embutidos em `cli.mjs`) — o launcher `bin/claudin` já resolve `dist/` relativo, então não há regressão de "single-file" do ponto de vista de instalação npm.

**Lazy-load por extensão:**

```ts
// pseudo, não implementar nesta PR
const GRAMMAR_BY_EXT: Record<string, () => Promise<Language>> = {
  '.ts': () => Parser.Language.load(resolve(__dirname, 'wasm/tree-sitter-typescript.wasm')),
  '.tsx': () => Parser.Language.load(resolve(__dirname, 'wasm/tree-sitter-tsx.wasm')),
  '.py': () => Parser.Language.load(resolve(__dirname, 'wasm/tree-sitter-python.wasm')),
  '.json': () => Parser.Language.load(resolve(__dirname, 'wasm/tree-sitter-json.wasm')),
}
```

Cache por linguagem em `Map<string, Language>` no escopo do módulo. Não há TTL — grammar é imutável dentro de uma sessão.

### Como o modelo descobre e usa

- Description curta no schema (estilo omp `ast-edit.md`):
  > "Apply AST-aware structural rewrites. Use for renames, codemods, and refactors where text Edit would need many duplicated calls or risk false matches. For single literal text changes, use Edit instead."
- Listar operações como tools individuais (`rename_symbol`, etc.) **ou** um único `AstEditTool` polimórfico com `op: "rename_symbol" | ...`. Recomendado o polimórfico — minimiza inflação do schema global (ver risco abaixo).
- Exemplos no prompt: 1 rename, 1 add_import, 1 replace_body. Curtos. Modelo aprende padrão por imitação.

### Riscos

1. **Schema crescente.** Cada nova op adiciona campos no schema do tool. Mitigação: schema polimórfico discriminado por `op`, com zod `discriminatedUnion`. Mede-se via `scripts/measure-tool-schemas.test.ts` (já existe — guard ativo).
2. **Modelo confuso "Edit vs AstEdit".** Risco real. Mitigação:
   - Prompt do `AstEditTool` deve abrir com "use Edit when…".
   - Prompt do `FileEditTool` ganha uma frase reciprocal mencionando AstEdit para refactors multi-arquivo. Frase curta, não inflar.
   - Telemetria local: contar `astEdit_fallback_to_edit` quando AstEdit retorna 0 matches e a próxima chamada do modelo é um Edit no mesmo path. Sinal pra ajustar prompt.
3. **Parse errors silenciosos.** ast-grep tolera (omp loga em `parse_errors`). Replicar: retornar `parseErrors: string[]` no result em vez de mascarar. Modelo aprende a re-tentar com pattern diferente.
4. **Bundle inflado para usuários que nunca rodam o tool.** WASM em `dist/wasm/` resolve — não está no `cli.mjs`. Mas usuários reportarão "claudin cresceu 2 MB no `npm i`". Documentar no CHANGELOG; opcional gate `feature('AST_EDIT')` em `scripts/build.ts` para builds enxutos.

### Não-objetivos

- **Não substituir `FileEditTool`.** Ele continua sendo a ferramenta padrão para edição. AST é especializada.
- **Não implementar refactors LSP-grade.** "rename across files com resolução de escopo" não é objetivo do MVP — para isso existe LSP rename e está fora do escopo (a infra LSP de Claudin já é usada para diagnostics, não para refactor).
- **Não cobrir 50 linguagens.** Começar com 3, expandir por demanda real.
- **Não tocar no `BashTool` tree-sitter atual.** Stack diferente (NAPI, propósito de segurança), não consolidar agora.

---

## Referências de arquivos

- omp: `/home/dev/projects/oh-my-pi/crates/pi-ast/src/language/parsers.rs`
- omp: `/home/dev/projects/oh-my-pi/crates/pi-ast/src/ops.rs:127-212`
- omp: `/home/dev/projects/oh-my-pi/crates/pi-natives/src/ast.rs:686-`
- omp: `/home/dev/projects/oh-my-pi/packages/coding-agent/src/tools/ast-edit.ts`
- omp: `/home/dev/projects/oh-my-pi/packages/coding-agent/src/prompts/tools/ast-edit.md`
- omp: `/home/dev/projects/oh-my-pi/packages/coding-agent/src/prompts/tools/replace.md`
- claudin: `/home/dev/projects/claudin/src/tools/FileEditTool/FileEditTool.ts:87-610`
- claudin: `/home/dev/projects/claudin/src/tools/FileEditTool/utils.ts` (`findActualString`, `normalizeQuotes`)
- claudin: `/home/dev/projects/claudin/src/tools/FileEditTool/types.ts`
- claudin: `/home/dev/projects/claudin/src/tools/FileEditTool/prompt.ts`
- claudin: `/home/dev/projects/claudin/src/tools/FileEditTool/FileEditTool.diagnostics.test.ts` (única coverage local)
- claudin: `/home/dev/projects/claudin/src/utils/bash/treeSitterAnalysis.ts` (uso atual NAPI tree-sitter, escopo Bash)
- spec original: `/home/dev/projects/claudin/docs/discovery/ohmypi/07-tree-sitter-ast-edits.md`
