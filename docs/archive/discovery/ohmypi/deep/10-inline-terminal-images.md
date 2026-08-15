# Deep #10 — Inline terminal images

## omp (`packages/tui/`)

- **Detecção em camadas** (`terminal-capabilities.ts:116-155`): env vars específicas → `TERM_PROGRAM` → `TERM`/`COLORTERM`.
- **Tabela `KNOWN_TERMINALS`** mapeia 7 terminais conhecidos para `(imageProtocol, trueColor, hyperlinks, notifyProtocol)`.
- **Probe ativo de Sixel** exclusivo para Windows Terminal: DA1 + XTSMGRAPHICS em paralelo, timeout 250 ms (`tui.ts:428-494`).
- **Encoders**: Kitty com chunking 4 KB (sem zlib — depende do PNG), iTerm2 OSC 1337, Sixel via binding nativo Rust (`@oh-my-pi/pi-natives`).
- **Header parsers próprios** para PNG/JPEG/GIF/WEBP em ~150 LOC, zero-dep.
- Componente `Image` reserva `rows-1` linhas vazias + cursor-up + raw sequence — padrão idêntico ao que `ink-picture` faz.
- **Fallback textual**: `[Image: filename [mime] WxH]`.

## Claudin (estado atual)

- `src/tools/FileReadTool/FileReadTool.ts:705-712` empacota imagem como Anthropic multimodal block (`type:'image', source:{base64,media_type}`); só vai pro modelo.
- UI para o usuário (`src/components/FileReadTool/UI.tsx:80-89`) é literal `Read image (size)`.
- `src/terminal/image/ClickableImageRef.tsx` gera OSC 8 hyperlink para `file://` — terceiriza o display para o viewer do SO.
- `src/terminal/ink/terminal.ts:120-167` já tem **XTVERSION probe assíncrona** — ponto de extensão natural para adicionar capability gráfica.
- Sem nenhuma renderização pixel-art em qualquer `<Component>` de `src/components/`.
- `sharp` (via `imageProcessor.ts`) e `imageResizer.ts` reaproveitáveis para encoders Kitty/iTerm2.

## Externos relevantes

- **`ink-picture`** resolve o problema completo para Ink — Kitty + iTerm2 + Sixel + braille/ASCII fallback. Tradeoff: ~200 KB e dependência externa.
- **`supports-terminal-graphics`** faz só detecção env-based (utilitário).
- **Issue upstream `anthropics/claude-code#2266`** já pede a feature.

## Recomendação

Prioridade BAIXA — esperar sinal de demanda interno. Quando implementar:

1. Atrás de feature flag `INLINE_IMAGES` (default off).
2. Começar com `ink-picture` (não reimplementar parsers PNG/JPEG/GIF próprios — não vale o custo de manutenção).
3. Restringir a **Kitty + iTerm2** na v1; sair com **Sixel** pelo risco de scrollback corrompido em terminais que falsamente declaram suporte.
4. Ponto de extensão: estender `src/terminal/ink/terminal.ts` `XTVERSION probe` para gravar `imageProtocol` na capability struct.
5. Hook em `FileReadTool` UI: se capability presente, render inline via `ink-picture`; senão, fallback atual (OSC 8 hyperlink).

## Não fazer

- Reimplementar parsers PNG/JPEG/GIF próprios. `ink-picture` cobre.
- Binding nativo Rust pra Sixel (omp tem). Dep nativa quebra single-file bundle.
- Suporte universal a todos os terminais — limitar a `KNOWN_TERMINALS` (whitelist) em vez de detect-and-pray.
