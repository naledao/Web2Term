import { progressVmModules } from './progress-vm-modules.mjs'
// Shared VM dependency for tests loading background task provenance; no IO beyond source reads.
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
import ts from 'typescript'

export const taskContextModule = {}
new Script(ts.transpileModule(readFileSync(new URL('../../src/shared/autonomous-task.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText).runInNewContext({ exports: taskContextModule, structuredClone, require: name => progressVmModules[name] })
