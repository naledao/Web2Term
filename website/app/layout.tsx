import type { Metadata } from 'next'
import './globals.css'
import { assetPath, PRODUCT_NAME } from './site-config'

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — 让对话抵达终端`,
  description: 'Web2Term 将模型网页、项目对话与本机／远程终端放进同一个工作区，支持定时任务、AI 邮件通知、后台任务和数据库工具箱。提供 Windows x64、macOS Apple Silicon 客户端与 Linux 设备工具，Windows 本机的 ChatGPT、DeepSeek 还可使用 Computer Use 桌面操作。',
  icons: {
    icon: assetPath('/brand-icon.png'),
    shortcut: assetPath('/brand-icon.png'),
    apple: assetPath('/brand-icon.png'),
  },
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  )
}
