#!/usr/bin/env bun
// Dump claudin's full system prompt (all blocks) as plain text, for diffing
// against Claude Code's. No network.
//   bun --preload ./src/stubs/test-preload.ts scripts/profile/dump-system-prompt.ts

;(globalThis as any).MACRO ??= new Proxy({}, { get: (_t, p) => `<MACRO.${String(p)}>` })

async function main() {
  const { getAllBaseTools } = await import('../../src/tools.js')
  const { getSystemPrompt } = await import('../../src/constants/prompts.js')
  const { enableConfigs } = await import('../../src/utils/config.js')
  try { enableConfigs() } catch {}
  process.env.NODE_ENV = 'production'
  const tools = getAllBaseTools()
  const blocks = await getSystemPrompt(tools, 'claude-sonnet-4-6')
  blocks.forEach((b, i) => {
    console.log(`\n┌── BLOCK ${i} ${'─'.repeat(50)}`)
    console.log(b)
  })
}
main().catch(e => { console.error(e); process.exit(1) })
