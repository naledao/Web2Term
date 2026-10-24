// User-run only: node --test tests/focus-layout.test.mjs
// Actual extraction/parser/renderer with synthetic DOM; no Electron, session or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script, createContext } from 'node:vm'
import { test } from 'node:test'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText).runInNewContext({ exports, require: name => dependencies[name] ?? {}, URL, Buffer })
  return exports
}
const { parseFocusLayout } = load('../src/shared/focus-layout.ts')
const { default: FocusLayout } = load('../src/renderer/src/components/FocusLayout.tsx', { react: React, 'react/jsx-runtime': jsxRuntime })
const source = readFileSync(new URL('../src/main/injected/send-interceptor.js', import.meta.url), 'utf8')
const ast = ts.createSourceFile('page.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
function find(predicate, node = ast) { return predicate(node) ? node : ts.forEachChild(node, child => find(predicate, child)) }
function helper(name, context) {
  const node = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name)
  return new Script('(' + node.initializer.getText(ast) + ')').runInContext(context)
}
const rules = { rootSelector: '[data-dil-message-id]', sourceIdAttr: 'data-dil-message-id', cardSelector: '[data-d-has-border]',
  groupSelector: '[role="radiogroup"][data-d-component]' }

class Element {
  constructor(tag, attrs = {}, children = [], css = {}, inline = {}) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = attrs; this.childNodes = children.map(value => typeof value === 'string' ? { nodeType: 3, nodeValue: value } : value)
    for (const child of this.childNodes) child.parentElement = this
    this.style = { getPropertyValue: key => inline[key] ?? '' }
    this.css = { display: ['span', 'strong', 'svg', 'path'].includes(tag) ? 'inline' : 'block', visibility: 'visible',
      color: 'rgb(13, 13, 13)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', lineHeight: '26px', fontWeight: '400',
      fontStyle: 'normal', textAlign: 'start', whiteSpace: 'normal', opacity: '1', flexDirection: 'row', flexWrap: 'nowrap',
      alignItems: 'normal', justifyContent: 'normal', alignSelf: 'auto', flexGrow: '0', flexShrink: '1', flexBasis: 'auto',
      minWidth: 'auto', maxWidth: 'none', minHeight: 'auto', maxHeight: 'none', rowGap: 'normal', columnGap: 'normal',
      width: '768px', height: 'auto', borderRadius: '0px', borderTopStyle: 'solid', gridTemplateColumns: 'none',
      gridRow: 'auto', gridColumn: 'auto', ...Object.fromEntries(['Top', 'Right', 'Bottom', 'Left'].flatMap(side =>
        [['padding' + side, '0px'], ['margin' + side, '0px'], ['border' + side + 'Width', '0px']])), ...css }
    this.isConnected = true
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1) }
  get textContent() { return this.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : node.textContent).join('') }
  get innerText() { return this.childNodes.map(node => node.nodeType === 3 ? node.nodeValue : node.innerText).join('\n') }
  getAttribute(key) { return this.attrs[key] ?? null }
  hasAttribute(key) { return key in this.attrs }
  getBoundingClientRect() { return { width: Number.parseFloat(this.css.width) || 768 } }
  contains(node) { return node === this || this.children.some(child => child.contains(node)) }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null }
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()))
    if (selector === rules.rootSelector) return this.hasAttribute('data-dil-message-id')
    if (selector === rules.cardSelector) return this.hasAttribute('data-d-has-border')
    if (selector === rules.groupSelector) return this.attrs.role === 'radiogroup'
    if (selector === '[data-d-component]') return this.hasAttribute('data-d-component')
    return this.tagName.toLowerCase() === selector
  }
  querySelectorAll(selector) {
    if (selector === ':scope > th, :scope > td') return this.children.filter(child => ['TH', 'TD'].includes(child.tagName))
    return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)])
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null }
}
const box = (children, css = {}, inline = {}) => new Element('div', { 'data-d-component': 'Box' }, children, css, inline)
function fixture() {
  const icon = new Element('svg', { viewBox: '0 0 24 24', width: '20', height: '20', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' },
    [new Element('path', { d: 'M4 4h6v6H4z M14 4h6v6h-6z', onclick: 'alert(1)' })], { width: '20px', height: '20px' })
  const title = new Element('strong', {}, ['高校行政工作台'], { fontWeight: '600' })
  const header = box([icon, box([title, new Element('small', {}, ['办公效率中心 · 首页'], { fontSize: '12px', color: 'rgb(110, 110, 110)' })]),
    new Element('span', {}, ['桌面版'])], { display: 'flex', columnGap: '12px', alignItems: 'center', borderBottomWidth: '1px', paddingBottom: '16px' })
  const nav = box(['首页', 'Excel 工具', 'Word 工具', 'PDF 工具', '文件工具', '我的模板', '处理记录'].map(label => new Element('p', {}, [label])),
    { display: 'flex', flexDirection: 'column', rowGap: '12px', flexShrink: '0', width: '120px' }, { width: '120px' })
  const cards = ['Excel 处理', 'Word 处理', 'PDF 处理', '文件整理'].map(label => new Element('div',
    { 'data-d-component': 'Box', 'data-d-has-border': '' }, [new Element('strong', {}, [label]), new Element('p', {}, ['批量处理 · 本地运行'])],
    { borderTopWidth: '1px', borderRightWidth: '1px', borderBottomWidth: '1px', borderLeftWidth: '1px', borderRadius: '8px', paddingTop: '12px', paddingRight: '12px', paddingBottom: '12px', paddingLeft: '12px' }))
  const grid = box(cards, { display: 'grid', gridTemplateColumns: '300px 300px', rowGap: '12px', columnGap: '12px' })
  const input = new Element('input', { type: 'search', placeholder: '搜索工具，例如：合并 Excel', value: 'private draft', oninput: 'steal()' })
  const main = box([new Element('h3', {}, ['今天要处理什么？'], { fontSize: '18px', fontWeight: '600' }), input, grid,
    new Element('p', {}, ['最近使用']), new Element('p', {}, ['批量生成通知书'])], { display: 'flex', flexDirection: 'column', rowGap: '12px', flexGrow: '1', flexBasis: '0%' })
  const outer = new Element('div', { 'data-d-component': 'Box', 'data-d-has-border': '' },
    [header, box([nav, main], { display: 'flex', columnGap: '16px', paddingTop: '16px' }), new Element('p', {}, ['界面布局示意，非已开发软件'])],
    { borderTopWidth: '1px', borderRightWidth: '1px', borderBottomWidth: '1px', borderLeftWidth: '1px', borderRadius: '20px',
      paddingTop: '16px', paddingRight: '16px', paddingBottom: '16px', paddingLeft: '16px' })
  const dil = new Element('div', { 'data-dil-message-id': 'answer-layout' }, [outer])
  const answer = new Element('div', {}, [new Element('h2', {}, ['一、整体产品形态']), dil, new Element('h2', {}, ['二、核心功能模块'])])
  const context = createContext({ PAGE: { focus: { smartUi: rules }, answerCharts: null }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    collapse: value => String(value || '').replace(/\s+/g, ' ').trim(), getComputedStyle: node => node.css,
    replyRootOf: () => answer, messageIdOf: () => 'answer-layout', isVisibleElement: node => node.css.display !== 'none' })
  context.smartUiCardsOf = () => []
  context.smartUiMarkdown = () => assert.fail('no radio card in this fixture')
  context.smartUiLayoutsOf = helper('smartUiLayoutsOf', context)
  context.layoutMarkdown = helper('layoutMarkdown', context)
  return { context, answer, outer, dil, nav, grid, icon, input, layouts: context.smartUiLayoutsOf, markdown: helper('readReplyMarkdown', context) }
}

function stageList(tag = 'div') {
  const rows = ['V0.1 — 最小可用版本', 'V0.2 — 日常办公版本', 'V1.0 — 可扩展平台'].map((title, index) => {
    const icon = new Element('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' },
      [new Element('path', { d: 'M5 3v18 M5 4h12v8H5' })], { width: '20px', height: '20px' })
    const text = box([new Element('p', {}, [title], { fontWeight: '600' }), new Element('p', {}, ['阶段说明 ' + (index + 1) + '：文件预览、批量处理和错误提示。'])],
      { display: 'flex', flexDirection: 'column', rowGap: '4px', flexGrow: '1', flexBasis: '0%' })
    return new Element(tag === 'ol' ? 'li' : 'div', { 'data-d-component': 'Item' }, [icon, text],
      { display: 'flex', flexDirection: 'row', columnGap: '16px', alignItems: 'flex-start', paddingTop: '20px', paddingBottom: '20px' })
  })
  const divider = () => new Element('div', { 'data-d-component': 'Divider' }, [],
    // User log: 17px occupied height = 1px line + 8px top/bottom spacing.
    { height: '1px', paddingTop: '8px', paddingBottom: '8px', backgroundColor: 'rgba(0, 0, 0, 0.1)' })
  return new Element(tag, { 'data-d-component': 'List' }, tag === 'ol' ? rows : [rows[0], divider(), rows[1], divider(), rows[2]],
    { display: 'flex', flexDirection: 'column' })
}

function append(parent, ...children) {
  for (const child of children) { child.parentElement = parent; parent.childNodes.push(child) }
}

test('native presentation extraction retains one complete dashboard with grid, sidebar, typography and SVG', () => {
  const f = fixture(), layouts = f.layouts({})
  assert.equal(layouts.length, 1, 'nested feature cards belong to the outer dashboard')
  const data = parseFocusLayout(JSON.stringify(layouts[0].data))
  assert.ok(data)
  const nodes = []
  const visit = node => { if (typeof node === 'string') return; nodes.push(node); (node.children ?? []).forEach(visit) }
  visit(data.root)
  assert.ok(nodes.some(node => node.style?.gridTemplateColumns === '0.5fr 0.5fr'))
  assert.ok(nodes.some(node => node.style?.width === '120px' && node.style?.flexDirection === 'column'))
  assert.ok(nodes.some(node => node.tag === 'path' && node.attrs.d.startsWith('M4')))
  const serialized = JSON.stringify(data)
  assert.match(serialized, /今天要处理什么/)
  assert.match(serialized, /搜索工具/)
  assert.equal(serialized.includes('private draft'), false)
  assert.equal(serialized.includes('onclick'), false)
  const html = renderToStaticMarkup(React.createElement(FocusLayout, { data }))
  assert.match(html, /grid-template-columns:0.5fr 0.5fr/)
  assert.match(html, /<svg[^>]*viewBox="0 0 24 24"/)
  assert.match(html, /var\(--fl-muted\)/)
  assert.match(html, /界面布局示意，非已开发软件/)
})

test('Markdown stores the layout at its original position with a readable fallback and escaped marker', () => {
  const f = fixture(), markdown = f.markdown({})
  assert.match(markdown, /## 一、整体产品形态[\s\S]*<!--focus-layout /)
  assert.match(markdown, /> .*高校行政工作台[\s\S]*## 二、核心功能模块/)
  const json = markdown.match(/<!--focus-layout (\{[^\n]*\}) -->/)[1]
  assert.ok(parseFocusLayout(json))
  const layout = f.layouts({})[0]
  layout.data.label = '标题 --> <script>'
  const marker = f.context.layoutMarkdown(layout).split(' -->')[0]
  assert.equal(marker.includes('<script>'), false)
})

test('native DIL strong spans retain full-sentence and inline emphasis outside layout cards', () => {
  const f = fixture()
  const strong = text => new Element('span', { 'data-d-component': 'Text', 'data-d-default-strong': '' }, [text], { fontWeight: '600' })
  append(f.dil, new Element('h2', {}, ['六、产品设计最重要的原则']),
    new Element('p', { 'data-d-component': 'Text' }, [strong('工具箱不是工具越多越好，而是高频工具足够可靠。')]),
    new Element('p', { 'data-d-component': 'Text' }, ['我建议下一步直接进入 ', strong('V0.1 的详细设计'), '：把主界面和四个工具确定下来。']))
  const markdown = f.markdown({})
  assert.match(markdown, /## 六、产品设计最重要的原则\n\n\*\*工具箱不是工具越多越好，而是高频工具足够可靠。\*\*\n\n/)
  assert.match(markdown, /我建议下一步直接进入 \*\*V0\.1 的详细设计\*\*：把主界面和四个工具确定下来。/)
  assert.equal((markdown.match(/<!--focus-layout /g) ?? []).length, 1, 'prose stays outside the existing dashboard')
})

test('native Text weight preserves paragraph boundaries, whitespace and code without nested bold delimiters', () => {
  const f = fixture()
  append(f.dil,
    new Element('p', { 'data-d-component': 'Text' }, [new Element('span', { 'data-d-component': 'Text' }, ['整句加粗'], { fontWeight: '600' })], { fontWeight: '600' }),
    new Element('p', { 'data-d-component': 'Text' }, ['普通文字 ', new Element('span', { 'data-d-component': 'Text' }, [' 局部加粗 '], { fontWeight: '600' }), '继续普通文字']),
    new Element('p', {}, [new Element('strong', {}, [new Element('span', { 'data-d-default-strong': '' }, ['已有 strong'])])]),
    new Element('p', {}, [new Element('span', { 'data-markdown-copy': 'inline-code', 'data-d-component': 'Text' }, ['const x = 1'], { fontWeight: '600' })]),
    new Element('p', {}, [new Element('span', { 'data-d-default-strong': '' }, ['   '])]),
    new Element('p', {}, ['仍是正常段落']))
  const markdown = f.markdown({})
  assert.match(markdown, /\n\n\*\*整句加粗\*\*\n\n普通文字/)
  assert.match(markdown, /普通文字  \*\*局部加粗\*\* 继续普通文字/)
  assert.match(markdown, /\*\*已有 strong\*\*/)
  assert.equal(markdown.includes('****'), false)
  assert.match(markdown, /\n\n`const x = 1`\n\n仍是正常段落$/)
})

test('Markdown table cells retain native emphasis and escape literal pipes', () => {
  const f = fixture()
  append(f.dil, new Element('table', {}, [new Element('tr', {}, [new Element('th', {}, ['层级']), new Element('th', {}, ['推荐方案'])]),
    new Element('tr', {}, [new Element('td', {}, ['界面']), new Element('td', {}, [
      new Element('span', { 'data-d-component': 'Text', 'data-d-default-strong': '' }, ['Vue 3']), ' | TypeScript'])])]))
  assert.match(f.markdown({}), /\| 界面 \| \*\*Vue 3\*\* \\\| TypeScript \|/)
})

test('an unbordered icon list beside a bordered dashboard keeps rows, SVG, bold titles and background dividers', () => {
  const f = fixture(), list = stageList()
  append(f.dil, new Element('h2', {}, ['四、第一版开发范围']), new Element('p', {}, ['不建议一开始把几十个功能全部做完。']),
    list, new Element('h2', {}, ['五、建议的技术架构']))
  const layouts = f.layouts({})
  assert.equal(layouts.length, 2, 'a bordered sibling must not suppress the unbordered list')
  assert.equal(layouts[0].element, f.outer)
  assert.equal(layouts[1].element, list)
  const data = parseFocusLayout(JSON.stringify(layouts[1].data))
  assert.equal(data.kind, 'list')
  const html = renderToStaticMarkup(React.createElement(FocusLayout, { data }))
  assert.match(html, /focus-layout--list/)
  assert.match(html, /min-width:0/)
  assert.doesNotMatch(html, /min-width:560/)
  assert.equal((html.match(/<svg/g) ?? []).length, 3)
  assert.equal((html.match(/(?:^|[;"])height:1px(?=;|")/g) ?? []).length, 2)
  assert.equal((html.match(/box-sizing:content-box/g) ?? []).length, 2, 'padding surrounds the one-pixel line instead of increasing its painted height')
  assert.equal((html.match(/background-clip:content-box/g) ?? []).length, 2, 'saved divider trees must not paint their padding')
  assert.equal((html.match(/padding:8px 0px 8px 0px/g) ?? []).length, 2, 'retain the native spacing above and below each divider')
  assert.equal((html.match(/background-color:var\(--fc-border\)/g) ?? []).length, 2, 'translucent native dividers remain visible in either theme')
  assert.equal((html.match(/font-weight:600/g) ?? []).length, 3)
  assert.match(html, /column-gap:16px/)
  assert.match(html, /阶段说明 3/)
  assert.equal(data.root.style.borderWidth, undefined, 'no new outer card border')
  const markdown = f.markdown({})
  const markers = [...markdown.matchAll(/<!--focus-layout (\{[^\n]*\}) -->/g)]
  assert.equal(markers.length, 2)
  assert.match(markdown, /## 四、第一版开发范围\s+不建议一开始把几十个功能全部做完。\s+<!--focus-layout /)
  assert.match(markdown, /阶段说明 3[^\n]*\n[\s\S]*## 五、建议的技术架构/)
  assert.equal((markdown.match(/^> V0\.1/gm) ?? []).length, 1, 'one readable fallback, with no duplicated plain list')
})

test('semantic icon lists and an icon list at the DIL root use the same fluid presentation', () => {
  const f = fixture(), list = stageList('ol')
  f.dil.childNodes = []
  append(f.dil, list)
  assert.equal(f.layouts({}).length, 1)
  assert.equal(f.layouts({})[0].data.kind, 'list')
  assert.equal(f.layouts({})[0].data.root.tag, 'ol')
  // A native response can use the DIL root itself as the column of rows.
  f.dil.childNodes = []
  append(f.dil, ...stageList().children)
  f.dil.css.display = 'flex'; f.dil.css.flexDirection = 'column'
  assert.equal(f.layouts({})[0].element, f.dil)
  assert.equal(f.layouts({})[0].data.kind, 'list')
})

test('an icon list within a dashboard stays in that dashboard, while ordinary text and grids are not lists', () => {
  const f = fixture()
  append(f.outer, stageList())
  assert.equal(f.layouts({}).length, 1)
  assert.equal(f.layouts({})[0].data.kind, undefined)
  const g = fixture(), prose = box([new Element('p', {}, ['普通说明一']), new Element('p', {}, ['普通说明二'])])
  append(g.dil, prose)
  assert.equal(g.layouts({}).length, 1)
  const h = fixture(), cards = stageList()
  cards.css.display = 'grid'
  append(h.dil, cards)
  assert.equal(h.layouts({}).length, 1)
})

test('layout parser rejects executable tags, event attributes, remote references, unsafe CSS and excessive depth', () => {
  const base = fixture().layouts({})[0].data
  for (const change of [value => { value.root.tag = 'script' }, value => { value.root.tag = 'iframe' },
    value => { value.root.attrs = { onclick: 'alert(1)' } }, value => { value.root.style.position = 'fixed' },
    value => { value.root.style.backgroundColor = 'url(https://example.com/pixel)' }, value => { value.kind = 'unknown' },
    value => { value.root.children = [{ tag: 'svg', children: [{ tag: 'use', attrs: { href: 'https://example.com/a.svg' } }] }] },
    value => { let node = value.root; for (let i = 0; i < 26; i++) { node.children = [{ tag: 'div' }]; node = node.children[0] } }]) {
    const value = JSON.parse(JSON.stringify(base)); change(value)
    assert.equal(parseFocusLayout(JSON.stringify(value)), null)
  }
})

test('native scripts are omitted, radio controls stay with the interactive adapter, and oversized trees fall back to Markdown', () => {
  const f = fixture()
  f.outer.childNodes.push(new Element('script', {}, ['do not execute']))
  assert.equal(JSON.stringify(f.layouts({})[0].data).includes('do not execute'), false)
  const group = new Element('div', { role: 'radiogroup', 'data-d-component': 'RadioGroup' })
  f.outer.childNodes = [group]
  group.parentElement = f.outer
  append(group, stageList())
  assert.equal(f.layouts({}).length, 0)
  const g = fixture()
  g.outer.childNodes = Array.from({ length: 601 }, () => new Element('span', {}, ['x']))
  assert.equal(g.layouts({}).length, 0)
  assert.equal(g.markdown({}).includes('<!--focus-layout'), false)
})
