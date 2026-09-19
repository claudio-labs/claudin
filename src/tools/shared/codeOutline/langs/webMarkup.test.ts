import { describe, expect, test } from 'bun:test'

import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'

describe('scanSymbols — CSS / SCSS', () => {
  test('top-level selectors, at-rules, and SCSS mixin/function', () => {
    const src = [
      '.header {',
      '  color: red;',
      '}',
      '',
      '#main, .content {',
      '  padding: 0;',
      '}',
      '',
      '@media (max-width: 600px) {',
      '  .header { color: blue; }',
      '}',
      '',
      '@mixin flex($dir) {',
      '  display: flex;',
      '}',
      '',
      '@keyframes spin {',
      '  from { transform: rotate(0); }',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'css')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['.header']).toMatchObject({
      kind: 'selector',
      startLine: 1,
      endLine: 3,
      depth: 0,
    })
    expect(byName['#main, .content']).toMatchObject({
      kind: 'selector',
      startLine: 5,
      endLine: 7,
    })
    // At-rule with a nested selector — the nested `.header` is NOT emitted.
    expect(byName['@media (max-width: 600px)']).toMatchObject({
      kind: 'selector',
      startLine: 9,
      endLine: 11,
    })
    expect(syms.filter(s => s.name === '.header')).toHaveLength(1)
    expect(byName.flex).toMatchObject({ kind: 'function', startLine: 13 })
    expect(byName.spin).toMatchObject({ kind: 'selector', startLine: 17 })
  })

  test('selectors inside comments are ignored; $variables are skipped', () => {
    const src = [
      '/* .ghost { color: red } */',
      '// .also-ghost { }',
      '$primary: #333;',
      '.real {',
      '  color: $primary;',
      '}',
    ].join('\n')
    const syms = scanSymbols(src, 'css')

    expect(syms.map(s => s.name)).toEqual(['.real'])
  })

  test('empty CSS yields no symbols', () => {
    expect(scanSymbols('', 'css')).toEqual([])
    expect(scanSymbols('/* just a comment */\n', 'css')).toEqual([])
  })
})

describe('scanSymbols — HTML', () => {
  test('headings, landmarks, and id-bearing elements with nesting depth', () => {
    const src = [
      '<!DOCTYPE html>',
      '<html>',
      '<head><title>x</title></head>',
      '<body>',
      '  <header>',
      '    <h1>Welcome</h1>',
      '    <nav id="mainnav">',
      '      <a href="#">Home</a>',
      '    </nav>',
      '  </header>',
      '  <section id="content">',
      '    <h2>Details</h2>',
      '  </section>',
      '</body>',
      '</html>',
    ].join('\n')
    const syms = scanSymbols(src, 'html')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.header).toMatchObject({
      kind: 'element',
      startLine: 5,
      endLine: 10,
      depth: 0,
    })
    // Heading text becomes the name; nested one level inside <header>.
    expect(byName.Welcome).toMatchObject({
      kind: 'heading',
      depth: 1,
      startLine: 6,
    })
    expect(byName['nav#mainnav']).toMatchObject({
      kind: 'element',
      depth: 1,
      startLine: 7,
      endLine: 9,
    })
    expect(byName['section#content']).toMatchObject({
      kind: 'element',
      depth: 0,
      startLine: 11,
    })
    expect(byName.Details).toMatchObject({ kind: 'heading', depth: 1 })
  })

  test('commented-out and scripted markup is ignored', () => {
    const src = [
      '<!-- <section id="ghost"><h1>Nope</h1></section> -->',
      '<script>',
      '  var s = "<section id=\\"fake\\">"',
      '</script>',
      '<main id="real">',
      '  <h1>Live</h1>',
      '</main>',
    ].join('\n')
    const syms = scanSymbols(src, 'html')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName['main#real']).toMatchObject({ kind: 'element' })
    expect(byName.Live).toMatchObject({ kind: 'heading' })
    expect(byName['section#ghost']).toBeUndefined()
    expect(byName['section#fake']).toBeUndefined()
  })

  test('empty HTML yields no symbols', () => {
    expect(scanSymbols('', 'html')).toEqual([])
    expect(scanSymbols('<p>just text</p>\n', 'html')).toEqual([])
  })
})

describe('scanSymbols — XML', () => {
  test('elements with id/name attrs and root are tracked', () => {
    const src = [
      '<?xml version="1.0"?>',
      '<beans>',
      '  <bean id="dataSource" class="DataSource"/>',
      '  <bean name="txManager" class="TxManager">',
      '    <property name="timeout" value="30"/>',
      '  </bean>',
      '</beans>',
    ].join('\n')
    const syms = scanSymbols(src, 'xml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))

    expect(byName.beans).toBeDefined()
    expect(byName.beans.kind).toBe('element')
    expect(byName.dataSource).toBeDefined()
    expect(byName.txManager).toBeDefined()
  })

  test('nested elements get correct depth', () => {
    const src = [
      '<root>',
      '  <child id="c1">',
      '    <grandchild id="g1"/>',
      '  </child>',
      '</root>',
    ].join('\n')
    const syms = scanSymbols(src, 'xml')
    const byName = Object.fromEntries(syms.map(s => [s.name, s]))
    expect(byName.root.depth).toBe(0)
    expect(byName.c1.depth).toBe(1)
    expect(byName.g1.depth).toBe(2)
  })

  test('comments and CDATA are not elements', () => {
    const src = [
      '<!-- this is a comment -->',
      '<root>',
      '  <![CDATA[some data]]>',
      '</root>',
    ].join('\n')
    const syms = scanSymbols(src, 'xml')
    const names = syms.map(s => s.name)
    expect(names).toContain('root')
    expect(names).not.toContain('!--')
  })

  test('empty fails open', () => {
    expect(scanSymbols('', 'xml')).toEqual([])
    expect(scanSymbols('<!-- only comment -->', 'xml')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Config (.properties / .env)
// ---------------------------------------------------------------------------
