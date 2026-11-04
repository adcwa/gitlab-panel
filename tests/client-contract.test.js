import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const dict = name => {
  const start = source.indexOf(`const ${name} = {`)
  const end = source.indexOf('\n    }', start)
  const body = source.slice(start, end)
  return [...body.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*:\s*'/g)].map(x => x[1])
}
test('native panel has a unique sidebar entry and no iframe or foreign application', () => {
  assert.match(source, /id: '@local\/gitlab-panel'/)
  assert.match(source, /name: 'sidebar\.panellist', id: PANEL, order: 40/)
  assert.match(source, /name: 'main', key: PANEL/)
  assert.doesNotMatch(source, /require\(['"]@deepseek-ai\//)
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|document\.body|localStorage|sessionStorage|createRoot|iframe/)
})
test('English and Chinese dictionary keys are unique, complete and use built-in locale ids', () => {
  const en = dict('en'), zh = dict('zh')
  assert.ok(en.length > 70)
  assert.equal(new Set(en).size, en.length)
  assert.equal(new Set(zh).size, zh.length)
  assert.deepEqual(en.toSorted(), zh.toSorted())
  const known = new Set(en)
  for (const x of source.matchAll(/\bt\('([^']+)'/g)) assert.ok(known.has(x[1]), `Missing ${x[1]}`)
  assert.match(source, /locale\.register\(NS, \{ en, zh/)
})
test('reads are identity-keyed and abortable; errors retain same-key data only', () => {
  assert.match(source, /JSON\.stringify\(\[action, args\]\)/)
  assert.match(source, /old\.key === key \? old\.data : null/)
  assert.match(source, /return \(\) => controller\.abort\(\)/)
  assert.match(source, /credentials: 'same-origin'/)
  assert.match(source, /value\?\.ok !== true/)
})
test('credential form does not retain tokens in view memory and binding requires confirmation', () => {
  assert.match(source, /type: 'password'/)
  assert.match(source, /setDraft\(old => \(\{ \.\.\.old, token: '' \}\)\)/)
  assert.doesNotMatch(source, /memory = \{[^\n]*token/)
  assert.match(source, /act\('bindCheckout',[^\n]*confirm: true/)
  assert.match(source, /act\('disconnect',[^\n]*confirm: true/)
  assert.doesNotMatch(source, /act\('(?:pushDelivery|publishDraft)'/)
})
test('styles inherit the Host palette and support narrow containers and keyboard focus', () => {
  const styles = source.slice(source.indexOf('const styles = `'), source.indexOf('\n`', source.indexOf('const styles = `')))
  assert.match(styles, /@container\(max-width:760px\)/)
  assert.match(styles, /:focus-visible/)
  assert.match(styles, /--dsw-alias-label-primary/)
  assert.doesNotMatch(styles, /#[a-fA-F0-9]{3,8}\b|rgba?\(|hsla?\(/)
})
