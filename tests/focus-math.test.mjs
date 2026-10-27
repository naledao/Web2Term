// User-run only: node --test tests/focus-math.test.mjs
// Real extraction and focus Markdown renderer, with KaTeX-generated synthetic DOM.
// No Electron, user session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Script } from 'node:vm'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import katex from 'katex'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { fromHtmlIsomorphic } from 'hast-util-from-html-isomorphic'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const previewRequire = createRequire(require.resolve('@uiw/react-markdown-preview'))
const { default: ReactMarkdown } = await import(previewRequire.resolve('react-markdown'))
const page = ts.createSourceFile('page.js', readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
const view = ts.createSourceFile('view.tsx', readFileSync(new URL('../src/renderer/src/components/FocusChatView.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
function initializer(file, name) {
  const find = node => ts.isVariableDeclaration(node) && node.name.getText(file) === name ? node.initializer : ts.forEachChild(node, find)
  const node = find(file)
  assert.ok(node, name)
  return node.getText(file)
}

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs
    this.childNodes = children.map(child => typeof child === 'string' ? { nodeType: 3, nodeValue: child } : child)
    for (const child of this.childNodes) child.parentElement = this
  }
  get children() { return this.childNodes.filter(child => child.nodeType === 1) }
  get textContent() { return this.childNodes.map(child => child.nodeValue ?? child.textContent).join('') }
  getAttribute(name) { return this.attrs[name] ?? null }
  matches(selector) {
    return selector.split(',').some(part => {
      part = part.trim()
      if (part.startsWith('.')) return (this.attrs.class || '').split(' ').includes(part.slice(1))
      const attribute = /^(\w+)\[([\w-]+)="([^"]+)"\]$/.exec(part)
      if (attribute) return this.matches(attribute[1]) && this.getAttribute(attribute[2]) === attribute[3]
      return this.tagName.toLowerCase() === part
    })
  }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
}
const el = (tag, children, attrs = {}) => new Element(tag, attrs, children)
function formula(tex, display = false) {
  const tree = fromHtmlIsomorphic(katex.renderToString(tex, { displayMode: display, strict: 'ignore' }), { fragment: true })
  const convert = node => node.type === 'text' ? node.value : new Element(node.tagName,
    Object.fromEntries(Object.entries(node.properties).map(([key, value]) => [key === 'className' ? 'class' : key, Array.isArray(value) ? value.join(' ') : String(value)])), node.children.map(convert))
  return convert(tree.children[0])
}
const extract = new Script('(' + initializer(page, 'readReplyMarkdown') + ')').runInNewContext({
  PAGE: { focus: null }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, replyRootOf: node => node
})
// Use the actual focus component and its actual plugin options. The preview wrapper
// is replaced by its underlying ReactMarkdown to avoid loading CSS in Node.
const exports = {}
const declarations = ['RICH_BLOCK', 'CHART_MARKER', 'mathRemarkPlugins', 'mathRehypePlugins', 'Markdown']
new Script(ts.transpileModule(declarations.map(name => `const ${name} = ${initializer(view, name)};`).join('\n') + '\nexports.Markdown = Markdown;', {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
}).outputText).runInNewContext({ exports, require, memo: React.memo, remarkMath, rehypeKatex,
  cleanFocusAnswer: value => value,
  MDEditor: { Markdown: ({ source, wrapperElement, ...props }) => React.createElement('div', wrapperElement, React.createElement(ReactMarkdown, props, source)) },
  parseFocusChart: JSON.parse, FocusChart: () => React.createElement('figure', null, 'chart')
})
const render = text => renderToStaticMarkup(React.createElement(exports.Markdown, { text, theme: 'light' }))

test('native inline math is extracted once from TeX, not MathML plus annotation plus HTML', () => {
  const tex = String.raw`20mm \times 40mm`
  const source = extract(el('p', ['已知条件：工作尺寸为 ', formula(tex), '。']))
  assert.equal(source, `已知条件：工作尺寸为 $${tex}$。`)
  const html = render(source)
  assert.equal((html.match(/class="katex"/g) || []).length, 1)
  assert.match(html, /×/)
  assert.doesNotMatch(html, /katex-error/)
})

test('fraction blocks and nested calculation lists keep math boundaries and structure', () => {
  const tex = String.raw`\text{单像素精度}=\frac{0.1mm}{3}\approx 0.033mm`
  const source = extract(el('div', [el('h3', ['确定单像素精度']), el('ul', [el('li', [
    el('p', ['计算：']), formula(tex, true), el('ul', [el('li', ['短边视野 = ', formula('20mm+5mm+5mm=30mm')])])
  ])])]))
  assert.equal(source.split(tex).length - 1, 1)
  assert.match(source, /\n  \$\$\n  /)
  const html = render(source)
  assert.match(html, /katex-display/)
  assert.match(html, /class="mfrac"/)
  assert.equal((html.match(/<ul>/g) || []).length, 2)
  assert.doesNotMatch(html, /katex-error/)
})

test('formulas on either side of a rich chart still use the math plugins', () => {
  const html = render('$x_1^2$\n\n<!--focus-chart {} -->\n> chart\n\n$\\sqrt{2}$')
  assert.match(html, /<figure>chart<\/figure>/)
  assert.equal((html.match(/class="katex"/g) || []).length, 2)
})

test('code remains literal and a partial formula does not destroy the rest of the reply', () => {
  const source = extract(el('div', [el('pre', [el('code', [String.raw`$x$ \frac{1}{2}`])]), el('p', ['后续说明'])]))
  const html = render(source + '\n\n$\\frac{1}{$\n\n最后一段。')
  assert.match(html, /<code>\$x\$ \\frac\{1\}\{2\}/)
  assert.match(html, /后续说明/)
  assert.match(html, /最后一段/)
})

test('missing TeX uses only one readable representation and preserves surrounding text', () => {
  const math = el('span', [el('span', ['duplicate'], { class: 'katex-mathml' }), el('span', ['20mm'], { class: 'katex-html' })], { class: 'katex' })
  assert.equal(extract(el('p', ['长度 ', math, '。'])), '长度 20mm。')
})
