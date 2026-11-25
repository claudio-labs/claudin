import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shouldHandleInputAsPaste,
  supportsClipboardImageFallback,
} from 'src/terminal/hooks/usePasteHandler.ts'

// The hook's paste flow needs a live Ink input loop, so its two path splits
// are pinned on the source: both go through splitPastedPaths, which
// dragDropPaths.test.ts covers, and no private copy of the regex is left.
test('splits pasted image paths only through splitPastedPaths', () => {
  const source = readFileSync(join(import.meta.dir, 'usePasteHandler.ts'), 'utf8')
  expect(source.match(/splitPastedPaths\(/g)?.length).toBe(2)
  expect(source).not.toContain('.split(/ (?=')
})

test('supports clipboard image fallback on Windows', () => {
  expect(supportsClipboardImageFallback('windows')).toBe(true)
})

test('supports clipboard image fallback on macOS', () => {
  expect(supportsClipboardImageFallback('macos')).toBe(true)
})

test('supports clipboard image fallback on Linux', () => {
  expect(supportsClipboardImageFallback('linux')).toBe(true)
})

test('does not support clipboard image fallback on WSL', () => {
  expect(supportsClipboardImageFallback('wsl')).toBe(false)
})

test('does not support clipboard image fallback on unknown platforms', () => {
  expect(supportsClipboardImageFallback('unknown')).toBe(false)
})

test('does not treat a bracketed paste as pending when no paste handlers are provided', () => {
  expect(
    shouldHandleInputAsPaste({
      hasTextPasteHandler: false,
      hasImagePasteHandler: false,
      inputLength: 'kimi-k2.5'.length,
      pastePending: false,
      hasImageFilePath: false,
      isFromPaste: true,
    }),
  ).toBe(false)
})

test('treats bracketed text paste as pending when a text paste handler exists', () => {
  expect(
    shouldHandleInputAsPaste({
      hasTextPasteHandler: true,
      hasImagePasteHandler: false,
      inputLength: 'kimi-k2.5'.length,
      pastePending: false,
      hasImageFilePath: false,
      isFromPaste: true,
    }),
  ).toBe(true)
})

test('treats image path paste as pending when only an image handler exists', () => {
  expect(
    shouldHandleInputAsPaste({
      hasTextPasteHandler: false,
      hasImagePasteHandler: true,
      inputLength: 'C:\\Users\\jat\\image.png'.length,
      pastePending: false,
      hasImageFilePath: true,
      isFromPaste: false,
    }),
  ).toBe(true)
})
