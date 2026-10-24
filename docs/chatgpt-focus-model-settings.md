# ChatGPT 专注页：模型与思考强度

顶部的新建对话按钮右侧提供“当前模型”和“思考强度”两个下拉框，另有小型刷新按钮。
ChatGPT 的模型选项来自当前网页菜单；DeepSeek 仍使用用户指定的固定信息。
进入已就绪、空闲的专注页后读取一次，刷新按钮可以重新读取；普通会话轮询只做被动读取，不反复打开网页菜单。

## 实测依据

用户运行 `chatgpt-model-settings-probe.cjs`，日志均在 `%TEMP%/gpt-login-diag/`：

- `chatgpt-model-settings-2026-10-24T16-38-51-146Z-28460.log` 第 5 行：
  触发器为 `button[data-codex-intelligence-trigger][aria-label="选择 ChatGPT 模型"]`。
  同一个原生 Radix 菜单包含强度视图和模型列表视图。
- 第 6 行：未激活的模型视图仍挂载在 `aria-hidden="true"` 的轨道中，
  因而读取模型列表和选中项不必先切换菜单视图。
- 第 9/20 行：`GPT-6`、`GPT-5.6 Sol` 为 `role="menuitemradio"`，
  选择前后的 `aria-checked` 从一项转移到另一项。
- `chatgpt-model-settings-2026-10-24T16-43-10-281Z-35468.log` 第 5/10/15 行：
  触发器的 `data-selected-reasoning-effort` 分别显示 `medium`、`none`、`high`；
  菜单标题对应 Medium、Instant、High。关闭菜单后属性仍可读。
- 第 9/12/16 行 `SLIDER-INPUT`：原生 `[data-reasoning-slider]` 内的
  `[role="slider"]` 为 `aria-valuemin="0"`、`aria-valuemax="2"`，
  左端为 none，中档为 medium，右端为 high。滑动过程的数值可能是小数，
  确认结果读取选中强度属性，不依赖动画帧、颜色或小数坐标。

菜单通过触发器的 `aria-controls` 和菜单的 `aria-labelledby` 双向关联。
读取隐藏模型轨道时保留单选语义；真正点击前要求选项可见且未处于隐藏轨道。
未确认模型、重复模型项、未知滑杆范围均不生成默认选择。

## 切换流程

渲染层请求经过工作区/平台/会话归属校验，与发送、上传、执行、提问等待和编辑互斥。
页面使用独立操作 token、任务代次和路径检查，菜单输入每步只派发一次。
主进程重新检查归属、URL、窗口焦点，页面重新检查目标、遮挡和坐标后，
才发送原生 `mouseMove / mouseDown / mouseUp`；坐标计入页面缩放。
只操作模型按钮、对应菜单项或实测滑杆，不写草稿、不提交消息、不调用或重放第三方 API。

选择模型时按需展开列表，点击当前页面中唯一匹配的单选项；
选择强度时在原生滑杆的对应位置点击。两种操作均回读确认，显示来源状态；
更换模型后重新读取其强度与可用控件。只关闭本次操作自己打开的菜单。
切换期间发送和其他设置按钮暂时禁用，失败显示检查原始视图的入口。

自动诊断进入现有 `chatgpt-focus-ui-*.log`，事件为 `model-setting-request/outcome`，
记录设置类型、固定原因和结果，不记录草稿、请求体或凭据。

## 用户验收

智能体只完成静态检查和 `npm run build`，不执行测试、启动 Electron 或访问真实页面。
以下离线测试由用户运行：

```powershell
node --test tests/focus-model-settings.test.mjs tests/focus-page.test.mjs
```

测试使用实际页面方法、原生输入派发器和 React 组件，配合合成 DOM/时钟，
覆盖隐藏模型轨道、三档强度、原生坐标缩放、单次输入、已有菜单保留、草稿保留、
未知/重复结构、跨会话失效、归属检查以及表单选中/禁用状态。

用户重启 `npm run dev` 后在 ChatGPT 专注页检查：

1. 顶部显示原网页的当前模型与强度，两项都可下拉选择。
2. 修改模型，切回原始视图核对单选项；修改强度并核对滑杆，再返回专注页检查同步。
3. 输入草稿后切换设置，确认草稿保留；任务运行时两项禁用。
4. 检查明暗主题与较窄聊天面板，刷新按钮能重新读取原网页设置。

交付状态为“构建通过，等待测试”，日志结构实测不等于专注页切换链路已验收。
