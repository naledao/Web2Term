import type { Metadata } from 'next'
import './globals.css'
import { assetPath, PRODUCT_NAME } from './site-config'

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — 让对话抵达终端`,
  description: 'Web2Term 将 ChatGPT、DeepSeek、Gemini 和 Claude 网页账号、四平台专注对话与多账号隔离、本机／SSH／web2term 终端放进同一个桌面工作区。支持 // 按需技能、会话压缩与跨账号交接、有序发送队列、SFTP 远程文本编辑、Windows 本机 PowerShell 远程终端、Computer Use、定时任务、AI 邮件通知、后台任务与数据库工具箱。',
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
