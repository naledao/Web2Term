# 专注对话 HTML 代码预览

## 行为

专注对话的 HTML 代码块右上角显示「运行预览」。点击后，将该代码块的纯文本源码发送给本地预览窗口，支持完整 HTML 文档和 HTML 片段，以及其中的 CSS 和 JavaScript。

- 明确标记为 `html`、`htm`、`xhtml` 的代码块提供入口。
- 未标记语言或标记为纯文本时，识别以 HTML 文档声明或常见 HTML 元素开头的代码。`xml` 和 `markup` 需要明确的 HTML 文档结构。
- JavaScript、JSX、TSX、CSS 等其他语言的代码块不因为包含 HTML 字符串而出现入口。
- 页面不会自动执行；每次点击打开独立快照。流式输出后续变化不刷新已经打开的预览，重新点击代码块按钮可以预览新版本。
- 窗口提供桌面宽度、390px 手机宽度、源码查看、重新运行和关闭；Escape 也能关闭。
- 页面运行异常或外部脚本、样式加载失败时，在窗口底部显示提示。只展示错误信息，不将生成页面的消息转发为应用操作。

入口位于所有专注对话共用的 `FocusCodeBlock`，预览 IPC 不接受平台标识或模型凭据，也不调用原网页的预览入口。适用于目前支持专注对话的平台，后续平台使用这个公共组件即可复用。

## 运行边界

每个窗口使用新的、不以 `persist:` 开头的 Electron session；不共享模型平台或应用主界面的登录分区。网络代理使用点击时的软件代理设置。预览不需要额外的 npm 依赖、构建服务器、临时 HTML 文件或平台接口。

预览窗口启用 Electron sandbox、context isolation 和 web security，不加载 preload、不启用 Node、不提供 `window.api`。生成页面放在仅允许脚本执行的 iframe sandbox 中，不赋予 `allow-same-origin`。原始源码仅以转义后的 iframe 属性和 pre 文本进入窗口外壳，不能拼接成外壳的可执行脚本。

支持内联 CSS/JavaScript、HTTPS CDN 脚本与样式、HTTPS 图片/字体/媒体，以及遵循浏览器 CORS 的 HTTPS 请求。外部资源需要网络可达。独立窗口不会继承应用主界面的 CSP，也不放宽主界面的 CSP。

本地相对路径、`file:`/自定义应用协议、HTTP 资源、需要 `eval` 的脚本、Node、JSX/TSX 编译、嵌套页面、表单提交、弹窗、下载和设备权限不在本次支持范围。生成页面使用独立来源，不提供 localStorage / Cookie 等持久存储。导航被阻止，同页锚点仍由浏览器处理。单次代码上限为 200 万个 UTF-16 代码单元，超限时显示错误。

关闭预览或关闭主窗口时，销毁预览页面、解除主窗口监听、关闭该预览 session 的网络连接并清理存储。

## 调研依据

- [Electron: Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)：iframe 遵循普通浏览器行为，可通过 sandbox 限制能力。
- [Electron: Security](https://www.electronjs.org/docs/latest/tutorial/security)：不可信内容需要禁用 Node、启用隔离、限制权限和导航，避免向页面暴露 Electron API。
- [Electron: Session](https://www.electronjs.org/docs/latest/api/session)：不以 `persist:` 开头的 partition 使用内存会话。
- [MDN: HTMLIFrameElement.srcdoc](https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc)：直接渲染 HTML 需要注意同源访问；不授予 sandbox 的 `allow-same-origin`，使生成内容保持独立来源。

## 验收方式

遵守仓库约定：智能体只运行 `npm run build`；以下测试由用户运行。

```powershell
node --test tests/focus-html-preview.test.mjs tests/focus-code.test.mjs tests/focus-math.test.mjs
```

这些测试使用合成 Electron/DOM 对象，覆盖识别、转义与模板注入、IPC 输入限制、窗口隔离、协议限制、权限和下载阻止、快照、工具栏交互和关闭/失败清理，不启动 Electron、不访问网络。测试通过也不能替代实际会话验收。

人工验收只使用仓库指定的启动方式：

```powershell
npm run dev
```

1. 在 DeepSeek 和 ChatGPT 的专注对话分别生成带 HTML 代码块的回复，确认均显示「运行预览」。
2. 生成包含内联样式和点击计数按钮的页面，点击运行，确认样式和按钮交互生效。关闭窗口后，对话和终端仍可继续使用。
3. 生成包含 HTTPS CDN 样式/脚本的页面，确认在软件代理配置可用时能加载；断网或无效资源地址时观察错误提示。
4. 切换桌面、手机和源码；操作页面后点击「重新运行」，确认恢复同一个快照的初始状态。
5. 流式生成期间点击运行，确认预览不跟随输出反复执行；生成结束后重新点击代码块按钮，确认打开最新代码。
6. 同一回复含多个 HTML 代码块时分别运行，确认窗口内容与所点代码块一致；JavaScript、JSX 和普通 XML 代码不出现误识别的入口。
7. 从源码展示含 `</pre>`、`</script>`、引号、中文和模板标记 `{{source}}` 的代码，确认预览窗口工具栏不被破坏，源码完整保留。
8. 分别通过关闭按钮、Escape 和关闭应用主窗口结束预览，确认没有残留预览窗口。

交付状态应报告为「构建通过，等待测试」。
