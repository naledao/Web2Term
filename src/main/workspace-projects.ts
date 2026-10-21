import { statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { WorkspaceProject, WorkspaceProjectDraft } from '../shared/types'

export function workspaceDirectory(value: string): string {
  const directory = value.trim()
  if (!directory) return ''
  if (!isAbsolute(directory)) throw new Error('请选择本机上的完整目录。')
  try {
    if (statSync(directory).isDirectory()) return resolve(directory)
  } catch { /* Report the missing directory rather than silently starting somewhere else. */ }
  throw new Error('项目目录不存在或无法访问，请重新选择目录。')
}

export function workspaceProjectDraft(value: unknown): WorkspaceProjectDraft {
  if (!value || typeof value !== 'object') throw new Error('项目内容无效。')
  const draft = value as Record<string, unknown>
  if (typeof draft.name !== 'string' || !draft.name.trim() || draft.name.trim().length > 120) {
    throw new Error('请输入 1–120 个字符的项目名称。')
  }
  if (typeof draft.directory !== 'string' || (draft.id !== undefined && (typeof draft.id !== 'string' || !draft.id))) {
    throw new Error('项目内容无效。')
  }
  return { id: draft.id as string | undefined, name: draft.name.trim(), directory: workspaceDirectory(draft.directory) }
}

export function workspaceSessionOptions(kind: 'local' | 'ssh' | 'web2term', projectId: unknown, projects: WorkspaceProject[]): {
  projectId: string | null; localCwd: string
} {
  if (projectId === undefined || projectId === null) return { projectId: null, localCwd: '' }
  const project = typeof projectId === 'string' ? projects.find(item => item.id === projectId) : null
  if (!project) throw new Error('项目不存在，请重新选择。')
  return { projectId: project.id, localCwd: kind === 'local' ? workspaceDirectory(project.directory) : '' }
}
