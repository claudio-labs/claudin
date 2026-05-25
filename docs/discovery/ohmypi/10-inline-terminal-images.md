# 10 — Inline terminal images (Sixel / Kitty / iTerm2)

omp renderiza imagens diretamente no terminal via protocolos gráficos. Claudio hoje passa a imagem só pro modelo (multimodal block) e exibe ao usuário como `Read image (size)` ou hyperlink OSC 8 que terceiriza pro viewer do SO.

## Onde isso vive em omp

- `packages/tui/src/terminal-capabilities.ts:116-155` — detecção em camadas: env vars → `TERM_PROGRAM` → `TERM`/`COLORTERM`. Tabela `KNOWN_TERMINALS` mapeia 7 terminais → `(imageProtocol, trueColor, hyperlinks, notifyProtocol)`.
- `packages/tui/src/tui.ts:428-494` — probe ativo de Sixel exclusivo para Windows Terminal (DA1 + XTSMGRAPHICS em paralelo, timeout 250 ms).
- Encoders próprios: Kitty (chunking 4 KB, sem zlib), iTerm2 (OSC 1337), Sixel (binding nativo Rust).
- Header parsers próprios PNG/JPEG/GIF/WEBP em ~150 LOC, zero-dep.
- Componente `Image` reserva `rows-1` linhas + cursor-up + raw sequence (padrão `ink-picture`).
- Fallback textual: `[Image: filename [mime] WxH]`.

## Onde isso encaixaria em Claudio

- `src/tools/FileReadTool/FileReadTool.ts:705-712` — hoje empacota imagem como Anthropic multimodal block (`{type:'image', source:{base64,media_type}}`); só vai pro modelo.
- `src/components/FileReadTool/UI.tsx:80-89` — saída literal `Read image (size)`.
- `src/components/ClickableImageRef.tsx` — OSC 8 hyperlink `file://` (terceiriza ao viewer).
- `src/ink/terminal.ts:120-167` — XTVERSION probe async já existe (extensão natural pra adicionar capability gráfica).
- `imageProcessor.ts` (sharp) + `imageResizer.ts` reaproveitáveis pra encoders Kitty/iTerm2.

## Por que voltou

Sinal de demanda existe (`anthropics/claude-code#2266`). Hoje o usuário tem que abrir o file:// no viewer externo — quebra fluxo em REPL. Caso de uso real: screenshots, diagramas mermaid renderizados, gráficos de bench.

Veredito do deep-dive: prioridade BAIXA, mas viável e barato via `ink-picture` (não reimplementar parsers).
