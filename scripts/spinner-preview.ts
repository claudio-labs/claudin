/**
 * Side-by-side preview of candidate spinner animations.
 *
 *   bun scripts/spinner-preview.ts
 *
 * Renders every candidate at the same wall clock so they can be compared
 * directly, then prints the cycle length of each. Quit with q or ctrl-c.
 */

type Frame = { char: string; dim: number; bold: boolean }
type Variant = {
  id: string
  name: string
  note: string
  cycleMs: number
  at(elapsedMs: number): Frame
}

const BRAND = { r: 215, g: 119, b: 87 } // theme.claude — Claude orange
const TICK_MS = 40

// The orbit that used to ship (with the resolved brand C).
const ORBIT = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// Heavier braille rotation — reads as a solid orb turning. Shipping today.
const ORB = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷']
// Fill then empty, bottom-left to top-right.
const BREATHE = ['⠁', '⠃', '⠇', '⠧', '⠷', '⠿', '⠷', '⠧', '⠇', '⠃']

function cycle(frames: string[], holdMs: number, elapsedMs: number): Frame {
  const i = Math.floor(elapsedMs / holdMs) % frames.length
  return { char: frames[i]!, dim: 0, bold: false }
}

const VARIANTS: Variant[] = [
  {
    id: '0',
    name: 'anterior',
    note: 'órbita 240ms ×3 voltas, depois C parado 5s',
    cycleMs: 10 * 240 * 3 + 3000 + 2000,
    at(t) {
      const orbitMs = 10 * 240 * 3
      const i = t % this.cycleMs
      if (i < orbitMs) return cycle(ORBIT, 240, i)
      return { char: 'C', dim: 0, bold: i < orbitMs + 3000 }
    },
  },
  {
    id: '1',
    name: 'órbita rápida + C curto',
    note: 'órbita 120ms ×3 voltas (3,6s), C 1,2s — mudança mínima',
    cycleMs: 10 * 120 * 3 + 700 + 500,
    at(t) {
      const orbitMs = 10 * 120 * 3
      const i = t % this.cycleMs
      if (i < orbitMs) return cycle(ORBIT, 120, i)
      return { char: 'C', dim: 0, bold: i < orbitMs + 700 }
    },
  },
  {
    id: '2',
    name: 'órbita pura',
    note: 'mesma órbita a 100ms, sem C — nunca para',
    cycleMs: 10 * 100,
    at(t) {
      return cycle(ORBIT, 100, t)
    },
  },
  {
    id: '3',
    name: 'orbe denso',
    note: 'braille cheio a 80ms — rotação sólida, mais presente',
    cycleMs: 8 * 80,
    at(t) {
      return cycle(ORB, 80, t)
    },
  },
  {
    id: '4',
    name: 'respiração',
    note: 'preenche e esvazia a 110ms — orgânico, sem giro',
    cycleMs: 10 * 110,
    at(t) {
      return cycle(BREATHE, 110, t)
    },
  },
  {
    id: '5',
    name: 'pulso de cor',
    note: 'ponto fixo, só o brilho respira (2s) — o mais discreto',
    cycleMs: 2000,
    at(t) {
      const phase = (t % 2000) / 2000
      // Sine 0..1..0, floored so it never disappears entirely.
      const level = (1 - Math.cos(phase * 2 * Math.PI)) / 2
      return { char: '●', dim: 0.65 * (1 - level), bold: false }
    },
  },
]

function color(dim: number): string {
  const k = 1 - dim
  const r = Math.round(BRAND.r * k + 40 * dim)
  const g = Math.round(BRAND.g * k + 40 * dim)
  const b = Math.round(BRAND.b * k + 40 * dim)
  return `\x1b[38;2;${r};${g};${b}m`
}

const RESET = '\x1b[0m'
const DIMTEXT = '\x1b[2m'

function render(t: number): string {
  const lines = VARIANTS.map(v => {
    const f = v.at(t)
    const bold = f.bold ? '\x1b[1m' : ''
    const glyph = `${color(f.dim)}${bold}${f.char}${RESET}`
    const label = v.name.padEnd(24)
    return ` ${DIMTEXT}${v.id}${RESET}  ${glyph}  ${label}${DIMTEXT}${v.note}${RESET}`
  })
  return lines.join('\n')
}

const out = process.stdout
out.write('\x1b[?25l') // hide cursor
out.write(`\n${DIMTEXT} spinners candidatos — q para sair${RESET}\n\n`)
out.write(render(0))

const start = Date.now()
const timer = setInterval(() => {
  out.write(`\x1b[${VARIANTS.length - 1}A\r`)
  out.write(render(Date.now() - start))
}, TICK_MS)

function quit(): void {
  clearInterval(timer)
  out.write(`${RESET}\x1b[?25h\n\n`)
  process.exit(0)
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.on('data', (buf: Buffer) => {
    const key = buf.toString()
    if (key === 'q' || key === '\x03') quit()
  })
}
process.on('SIGINT', quit)
