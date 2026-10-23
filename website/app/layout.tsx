import type { Metadata } from 'next'
import './globals.css'
import { assetPath, PRODUCT_NAME } from './site-config'

export const metadata: Metadata = {
  title: `${PRODUCT_NAME} — 让对话抵达终端`,
  description: 'Web2Term 支持 Windows 与 macOS Apple Silicon，将四种模型网页、项目对话、本机与远程终端放进同一个工作区，提供专注对话、后台任务、GitHub 仓库管理与数据库工具箱，并配套 Linux 设备工具。',
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
