// Shared actual modules for the user-run VM tests. No process, desktop or network IO.
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(path, dependencies = {}) {
  const exports = {}
  new Script(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText).runInNewContext({ exports, structuredClone, require(name) {
    if (!Object.hasOwn(dependencies, name)) throw new Error('Unexpected progress dependency: ' + name)
    return dependencies[name]
  } })
  return exports
}
const shared = load('../../src/shared/computer-progress.ts')
const completion = load('../../src/shared/task-completion.ts')
const clarification = load('../../src/shared/task-clarification.ts')
const completionMain = load('../../src/main/task-completion.ts', { 'node:crypto': crypto, 'node:path': path,
  'node:fs/promises': { lstat: async () => { throw new Error('Synthetic fixture never reads actual artifacts') } } })
export const progressVmModules = {
  '../shared/task-presentation': load('../../src/shared/task-presentation.ts'),
  './task-observation-preview': load('../../src/main/task-observation-preview.ts'),
  './task-clarification': clarification,
  '../shared/task-clarification': clarification,
  './task-completion': { ...completion, ...completionMain },
  '../shared/task-completion': completion,
  './computer-progress': shared,
  '../shared/computer-progress': shared,
  '../shared/computer-diagnostics': load('../../src/shared/computer-diagnostics.ts'),
  './task-progress-guard': load('../../src/main/task-progress-guard.ts', { 'node:crypto': crypto, '../shared/computer-progress': shared })
}
