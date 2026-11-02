# Windows 开发版名称、图标与通知

仍使用 `npm run dev` 启动。Windows 下，electron-vite 在启动应用前准备独立的开发运行时副本：

- 缓存在 `.cache/windows-dev-runtime/`，不进入 Git 或安装包。
- 修改副本的 PE 产品名、文件描述和内嵌图标，不修改上游 `node_modules/electron/dist`。
- 保留 `electron.exe` 文件名，避免 Electron 44 的 `app.isPackaged` 被改变。
- 按上游 EXE、版本和 ICO 内容复用缓存；新版本使用新目录，避免覆盖仍在运行的副本。
- 由 electron-vite 的 `ELECTRON_EXEC_PATH` 使用该副本，开发入口和热更新仍由 electron-vite 管理。

启动终端应出现 `[dev-runtime] Executable:`，路径位于上述缓存目录中。首次准备还会输出 `Prepared Web2Term (Development)`。
`npm run build` 跳过开发运行时准备，不启动 Electron。

开发版使用独立 AUMID `com.example.gptweb2codexterminal.development`，显示名为 `Web2Term (Development)`。
启动时为同名开始菜单快捷方式设置开发运行时、项目路径、图标和 ToastActivatorCLSID；
确认替代快捷方式可用后，才清理 AUMID 与本项目原运行时都匹配的旧 `Electron.lnk`。
安装版 `Web2Term.lnk` 和其他应用的快捷方式不参与该迁移。

主窗口在首次显示前设置 taskbar AppID、图标资源及成对的重新启动命令／显示名。
通知注册表的 `DisplayName`、`IconUri` 使用 `REG_EXPAND_SZ`，`CustomActivator` 使用 `REG_SZ`。

智能体仅构建与静态检查。离线回归由用户运行：

```powershell
node --test tests/windows-dev-runtime.test.mjs tests/windows-app-details.test.mjs tests/windows-notification-identity.test.mjs tests/desktop-notifications.test.mjs tests/app-identity.test.mjs
```

真实验收需完整退出当前开发进程，重新运行 `npm run dev`。核对启动终端的运行时路径、任务栏底图、
一条新通知的名称／图标，以及通知点击后回到原会话的行为。旧通知和此前固定的任务栏入口不能替代新运行实例的验收。
