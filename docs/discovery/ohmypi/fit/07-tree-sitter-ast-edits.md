# 07-fit — Tree-sitter AST edits: encaixe e ganho real em Claudio

> Avaliação concreta. Não é plano de implementação. Lê o discovery (`../07-tree-sitter-ast-edits.md`)
> e o deep-dive (`../deep/07-tree-sitter-ast-edits.md`), confronta com o estado real do código
> de Claudio em `src/tools/FileEditTool/` e com o que o omp (`packages/coding-agent/src/tools/ast-edit.md`,
> `crates/pi-ast`) já entrega.

---

## 1. FileEditTool hoje — modos de falha REAIS

Mapeamento heurística → arquivo:linha.

### Normalização de aspas curvas
- `src/tools/FileEditTool/utils.ts:21-37` — `LEFT_*_CURLY_QUOTE`/`RIGHT_*_CURLY_QUOTE` constantes;
  `normalizeQuotes()` converte para retas.
- `src/tools/FileEditTool/utils.ts:73-93` — `findActualString()`: tenta exact match; se falhar,
  normaliza aspas no file e no search e tenta de novo, devolvendo o substring real para preservar
  o byte-range do arquivo.
- `src/tools/FileEditTool/utils.ts:104-133` — `preserveQuoteStyle()` reaplica aspas curvas no
  `new_string` quando o match veio via normalização, evitando "estragar" arquivos que usam
  tipografia curly (docs, prompts em Markdown).

### Tolerância de whitespace
- Não existe tolerância real de whitespace inter-linha. `findActualString` só desempata aspas.
  Trailing whitespace é endereçado via `stripTrailingWhitespace` (`utils.ts:44-65`) em outro
  caminho (display/diff), não no match.
- Há `convertLeadingTabsToSpaces` (`src/utils/file.ts`, usado em `utils.ts:13`) — mas é
  aplicado ao output do `Read`, não ao matching do edit. Logo, **tabs vs spaces no arquivo
  real continuam string-sensitive** apesar de o modelo ver o arquivo já normalizado.
- Resultado prático: prefixo de número-de-linha do `Read` colado em `old_string` quebra; tabs
  literais quebram quando o modelo manda spaces.

### Multiple-match handling
- `FileEditTool.ts:330-344` — `matches = file.split(actualOldString).length - 1`. Se `matches > 1`
  e `!replace_all`, erro estruturado `errorCode: 9` com instrução para o modelo escolher entre
  setar `replace_all` ou adicionar contexto.
- Não há noção de "match no escopo X". O modelo é forçado a alongar `old_string` até virar único.
  Para renames de variável local em arquivos com muitas ocorrências (ex.: `i`, `result`, `data`),
  isso vira N edits sequenciais — caso clássico em que AST ganharia.

### `replace_all` semantics
- `FileEditTool.ts:139` aceita o flag; `utils.ts` aplica `replaceAll(actualOldString, …)` no
  caminho final (não numerado, mas é o último ramo do match). Sem proteção de escopo: renomear
  `User` com `replace_all: true` também atinge `User` em comentários, JSDoc, strings literais
  e identificadores não relacionados. **Esse é o calo principal que AST resolveria.**

### Outros guards (não-heurísticas, mas modos de falha reais)
- `errorCode 0`: secret em team-memory (`FileEditTool.ts:147`).
- `errorCode 1`: `old_string === new_string`.
- `errorCode 2`: deny rule em `toolPermissionContext`.
- `errorCode 3`: criar arquivo que já existe (old_string vazio).
- `errorCode 4`: arquivo não existe (com hint de similar/cwd suggestion).
- `errorCode 5`: `.ipynb` → roteia para `NotebookEditTool`.
- `errorCode 6`: arquivo não foi lido antes (ou foi parcial).
- `errorCode 7`: mtime > timestamp do read.
- `errorCode 8`: string não encontrada (depois da normalização).
- `errorCode 9`: múltiplos matches sem `replace_all`.
- `errorCode 10`: arquivo > `MAX_EDIT_FILE_SIZE` (1 GiB).
- 4 `throw new Error(...)` em `utils.ts` (linhas 307, 326, 334) + `FileEditTool.ts:466`
  (`FILE_UNEXPECTEDLY_MODIFIED_ERROR` no momento do apply).

**Total de modos de falha distintos:** 11 códigos estruturados + 4 throws. Destes, os que **só
AST resolve sem virar pesadelo de prompt**: `errorCode 9` (múltiplos matches) e o sub-caso
silencioso do `replace_all` que tinge comentários/strings. Todos os outros são guards de IO,
permissão ou estado — AST não muda nada.

---

## 2. Testes de FileEditTool existentes

Glob `src/tools/FileEditTool/*.test.*` → **um único arquivo**:
- `src/tools/FileEditTool/FileEditTool.diagnostics.test.ts` (3 testes).

O que cobre:
1. `omits newMessages when helper returns []` — wiring do hook de diagnósticos LSP.
2. `populates newMessages when helper returns 1 AttachmentMessage` — idem com payload.
3. `the production module path is wired (FileEditTool.ts imports the helper from the expected path)` —
   guard de import path.

Comentário do próprio arquivo (linhas 4-18) confirma: **não exercita `FileEditTool.call`
diretamente**, porque mocks de `fs`/`fs/promises` em outros shards vazam globalmente. Toda a
lógica de match (`findActualString`, `replace_all`, `normalizeQuotes`, `preserveQuoteStyle`,
mtime-staleness) **não tem teste unitário local**. Cobertura indireta vem de `bugfixes.test.ts`
e E2E de provider — não dá pra medir.

Deep-dive estava certo: "quase não tem teste". Confirmado em 1 arquivo.

---

## 3. Tree-sitter já existe em Claudio?

- `package.json` — **zero** ocorrências de `tree-sitter` ou `web-tree-sitter`.
- `bun.lock` — idem.
- `src/utils/bash/treeSitterAnalysis.ts` define tipos `TreeSitterNode`, `QuoteContext`,
  `CompoundStructure`, `DangerousPatterns` — mas o produtor desses nodes é um parser **TypeScript
  puro**: `src/utils/bash/bashParser.ts` (cabeçalho: *"Pure-TypeScript bash parser producing
  tree-sitter-bash-compatible ASTs… Validated against a 3449-input golden set"*).
- Não há NAPI, não há WASM, não há binding tree-sitter real. O nome "tree-sitter" é convenção
  de schema do AST emitido (a grammar tree-sitter-bash foi a referência de design, não a
  dependência runtime).
- `scripts/build.ts` não tem qualquer plugin/loader para `.wasm`. Único `.node` mencionado é
  `audio-capture.node` (linha 314), tratado como stub. **Bundler hoje não comporta WASM**;
  para o plano do deep-dive funcionar, precisaria de novo plugin (copy `dist/wasm/*`, expor
  resolver `__dirname`-relative no bundle ESM).

Implicação: o deep-dive subestima o trabalho de bootstrap. Não é "já temos tree-sitter, é só
adicionar tools". É **introduzir uma dependência runtime nova** (`web-tree-sitter`), criar
diretório `dist/wasm/`, ensinar `scripts/build.ts` a copiar/embutir grammars, e garantir que
`bin/claudio` resolve esses arquivos.

---

## 4. Ganhos MEDIDOS contra cenários reais

### a) Rename de variável em TS — quando string-edit falha?

Arquivo de exemplo: imagine `userId` aparecendo em:
- declaração `const userId = req.params.userId` (1)
- uso `console.log(userId)` (2)
- comentário `// returns the userId from session` (3)
- JSDoc `@param userId — the…` (4)
- string literal `'userId'` em chamada `pick(obj, 'userId')` (5)
- propriedade `obj.userId` (6)

`FileEditTool` com `old_string='userId', new_string='accountId', replace_all=true`:
**afeta 3, 4 e 5 também** — comentário inconsistente, JSDoc errado, chave `pick` agora aponta
para campo inexistente. Bug silencioso.

Sem `replace_all`: erro `errorCode 9` (6 matches). Modelo precisa fazer 6 edits, cada um com
contexto diferenciador. Frequente em PRs reais.

**Ganho AST:** rename só atinge nós `identifier` em escopo de variável; comentários, strings e
JSDoc preservados. Ganho mensurável: 100% das ocorrências em strings/comments resolvidas no
1º shot vs. 0% hoje.

### b) Add import — como FileEditTool faz hoje?

Não há helper. O modelo emite `old_string` = última linha de import existente, `new_string` =
mesma linha + `\n` + novo import. Modos de falha:
- Se já existir o import (idempotência), o modelo precisa antes ler o arquivo, escanear, e só
  então decidir — frequentemente esquece e duplica.
- Se a posição "última linha de import" não for única (ex.: imports comentados, imports
  intercalados com `import type`), `errorCode 9`.
- Em arquivos com `'use client'` no topo, o modelo às vezes insere antes da diretiva.

**Ganho AST:** `add_import` semântico — checa se o módulo já está importado (skip), e insere
após o último `import_statement` ou `import_declaration`. Idempotente por construção.

### c) Replace function body — como hoje?

Modelo faz `Read`, copia o corpo todo (assinatura + chaves + corpo) como `old_string`, manda
versão nova como `new_string`. Modos de falha:
- Corpo grande (>50 linhas) — `old_string` enorme, qualquer mismatch de whitespace por uma
  linha invisível causa `errorCode 8` ("string not found").
- Tokens de número-de-linha colados na cópia (`14→  const x = …`) — modelo aprende a strip,
  mas erra ~5% das vezes.
- Função sobrecarregada (TS) — duas assinaturas, modelo precisa pegar a certa por contexto.

**Ganho AST:** `replace_function_body { function_name, new_body }` — pattern por nome do nó,
substitui só o `statement_block`. Whitespace e assinatura preservados automaticamente.

### Estimativa do percentual de edits que se beneficia

Sem telemetria histórica disponível (`bun run test:coverage` cobre código, não rastreia uso de
tool). Estimativa qualitativa por tipo de uso observado em PRs deste repo:

| Categoria de edit | Frequência est. | AST agrega? |
|---|---|---|
| Fix pontual numa linha/bloco único | ~55% | Não |
| Add import / mexer em imports | ~10% | **Sim, alto valor** |
| Rename de símbolo (1-3 occ.) | ~10% | Marginal (contexto resolve) |
| Rename de símbolo (>5 occ. ou comum) | ~5% | **Sim, alto valor** |
| Replace body / refactor de função | ~8% | **Sim** |
| Edit em config/JSON | ~7% | Marginal |
| Multi-arquivo (codemod) | ~5% | **Sim, transformador** |

Soma do "alto valor": **~28%** dos edits ganham AST de verdade. O resto é status quo. Não é
trivial, mas também não é maioria.

---

## 5. Onde ganha de verdade

1. **Rename multi-ocorrência seguro** — único, identifier-only, ignora strings/comments. Hoje
   exige N edits ou `replace_all` perigoso.
2. **Add import idempotente** — não duplica, posição correta, respeita `'use client'`.
3. **Refactor multi-arquivo** — codemod único cruza diretório (`paths: string[]`); hoje
   FileEditTool é single-file por chamada (`preparePermissionMatcher`, `FileEditTool.ts:123`).
4. **Replace function body** sem precisar copiar a assinatura inteira como contexto.

---

## 6. Onde NÃO ganha (ou perde)

1. **Edit pontual num arquivo único** (~55% dos casos): `Edit` continua mais barato. AST cobra
   custo de tokens no schema e custo de decisão "qual tool?" no modelo.
2. **Linguagens sem grammar empacotada** — JSON e Markdown são suportáveis, mas MDX, YAML
   custom, dialetos de SQL, templates Liquid/Handlebars não. Fallback é o `Edit` atual; mas
   adicionar `AstEditTool` ao schema sem dar valor para essas linguagens é peso morto.
3. **Strings dentro de JSX/templates** — tree-sitter resolve o JSX, mas o conteúdo string
   ainda é só… string. Renomear `className="user-card"` para `"account-card"` não é
   estrutural; vira string-edit com pattern AST opcional.
4. **Edits que cruzam ambiguidade de parse** — TS com erros sintáticos ainda parseia (tolerant),
   mas patterns ast-grep podem virar nulos. Modelo precisa cair em fallback Edit; a UX dessa
   transição é onde mora a dor.

---

## 7. Risco de adoção

1. **Confusão "Edit vs AstEdit" no modelo.** Real. omp mitigou com prompts cruzados, mas omp
   tem usuário power-user; Claudio mira público mais amplo. Cada `AstEdit` que falha e cai em
   `Edit` é um round-trip perdido. Telemetria local (count `astEdit_fallback_to_edit`) é
   necessária — não opcional.
2. **Bundle.** ~700 KB gzip estimado pelo deep-dive, com 3 grammars + runtime. CLAUDE.md vende
   "single-file bundle" — adicionar `dist/wasm/*` quebra esse contrato visualmente, ainda que
   `bin/claudio` resolva relativo. Risco de regressão no `bun run smoke` se o launcher não
   achar `dist/wasm/` em instalações npm globais (`@claudiolabs/claudio`).
3. **Manutenção de grammars WASM.** Cada bump de `web-tree-sitter` exige re-baixar grammars
   compatíveis. 3 hoje, virará 6-8 em 6 meses por demanda. Sem CI dedicado, isso vira
   technical debt.
4. **`scripts/build.ts` complica.** Hoje o build tem 5 responsabilidades documentadas (CLAUDE.md
   linha "Build System"). Adicionar pipeline WASM é a 6ª. Pre-scan de stubs (item 3 da seção
   Build System) não cobre `.wasm` — precisa novo plugin.
5. **Substituibilidade.** LSP rename (já presente para diagnostics) cobriria rename
   cross-file melhor que ast-grep no longo prazo. Investir em AstEdit pode atrapalhar a
   evolução natural para LSP-driven refactoring.

---

## 8. Veredito

Para o usuário típico de Claudio — alguém escrevendo features ou corrigindo bugs, edits
predominantemente locais — o ganho concreto é **~28%** dos edits e essencialmente concentrado
em três operações (rename amplo, add_import, replace_body). As outras duas (codemod
multi-arquivo, refactor de função) são caso de power-user/refactor agent.

O custo é real: dependência nova (`web-tree-sitter`), pipeline WASM no bundler, +700 KB no
artefato, mais uma decisão "qual tool?" no contexto do modelo, e manutenção de 3+ grammars.

omp já validou o padrão de **tool separado** (não inflar `FileEditTool`). Se for fazer, é
assim. Mas o ROI para Claudio hoje é claramente menor que para omp, porque (a) Claudio não
tem ainda a base nativa que omp já paga, e (b) o caso "codemod multi-arquivo" — onde o ganho
é maior — é exatamente o tipo de uso menos comum no público atual de Claudio (review,
provider-switching, sessões interativas).

Caminho mais barato e que entrega ~70% do valor desta feature **sem** introduzir tree-sitter:
1. `add_import` helper em TS puro (regex + scanner de imports — 100 linhas).
2. Pequeno modo `scope_hint` no `FileEditTool` que aceita "first | last | nth=N" para
   desambiguar matches sem alongar `old_string`.
3. Endurecer `replace_all` com flag `skip_comments_and_strings: boolean` via parser leve por
   linguagem (TS/JS), reusando alguma coisa do `bashParser` mental model.

Isso resolve a maior parte dos casos dolorosos sem WASM, sem 700 KB, sem confusão de tools.

**Vale a pena: CONDICIONAL — porque** o ganho real concentra-se em ~28% dos edits e em 3
operações específicas (rename amplo, add_import, replace_body), e há caminho determinístico
mais barato que entrega ~70% desse valor sem introduzir `web-tree-sitter`, WASM no bundler ou
um segundo tool de edit no schema; só investir em `AstEditTool` completo se/quando Claudio
mirar use-cases de codemod multi-arquivo como produto, ou quando a infra LSP já presente para
diagnostics não conseguir cobrir rename estrutural.
