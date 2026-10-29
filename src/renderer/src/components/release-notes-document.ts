const ALLOWED = new Set('html body main article section header footer aside figure figcaption div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong b em i u s del ins small sub sup mark kbd samp var abbr time address details summary blockquote pre code br hr table thead tbody tfoot tr th td caption a img'.split(' '))

/** Parse in a template's inert document; nothing is inserted into the app DOM. */
export function releaseNotesDocument(html: string, dark: boolean): string {
  const template = document.createElement('template')
  template.innerHTML = html
  for (const element of template.content.querySelectorAll('*')) {
    if (!ALLOWED.has(element.localName)) { element.remove(); continue }
    const image = element.localName === 'img' ? element.getAttribute('src') : null
    for (const attribute of [...element.attributes]) {
      const name = attribute.name
      if (name === 'title' || name === 'alt') continue
      if ((name === 'colspan' || name === 'rowspan') && /^(?:[1-9]|1[0-9]|20)$/.test(attribute.value)) continue
      element.removeAttribute(name)
    }
    // No remote images, navigations, styles, scripts, forms, or nested frames.
    if (image && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=]+$/i.test(image)) element.setAttribute('src', image)
  }
  const body = template.innerHTML
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><meta name="color-scheme" content="${dark ? 'dark' : 'light'}"><style>
    *{box-sizing:border-box}html{color-scheme:${dark ? 'dark' : 'light'};${dark ? 'background:#080808;scrollbar-color:#444 #080808' : ''}}body{margin:0;padding:20px 24px;background:${dark ? '#080808' : '#fff'};color:${dark ? '#ededed' : '#273247'};font:14px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}h1,h2,h3,h4{line-height:1.45;margin:1.2em 0 .6em}body>:first-child{margin-top:0}p,ul,ol,pre,blockquote{margin:.7em 0}li+li{margin-top:.25em}pre,code{font-family:Consolas,monospace;background:${dark ? '#151515' : '#f2f5fa'};border-radius:5px}code{padding:2px 5px}pre{padding:12px;overflow:auto;white-space:pre-wrap}pre code{padding:0}blockquote{margin-left:0;padding-left:14px;border-left:3px solid ${dark ? '#555' : '#8293c8'}}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid ${dark ? '#333' : '#dce2ed'};padding:7px 10px}img{max-width:100%;height:auto}a{color:${dark ? '#aabcf5' : '#526bb1'}}hr{border:0;border-top:1px solid ${dark ? '#333' : '#e3e8f1'}}
  </style></head><body>${body || '<p>此版本暂未提供正文。</p>'}</body></html>`
}
