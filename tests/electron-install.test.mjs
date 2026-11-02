// USER-RUN ONLY: node --test tests/electron-install.test.mjs
// Offline fixtures and injected installers only. No Electron or network requests.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  DEFAULT_MIRROR, OFFICIAL_MIRROR, LOCAL_PROXY, downloadEnvironment,
  downloadMirrors, installElectron, isInstalled, safeError
} from '../build/install-electron.mjs'

test('existing complete installs skip all network checks and installation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'w2t-electron-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '44.5.0' }))
  writeFileSync(join(root, 'dist/version'), '44.5.0')
  const executable = process.platform === 'win32' ? 'electron.exe'
    : process.platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron'
  mkdirSync(join(root, 'dist', executable, '..'), { recursive: true })
  writeFileSync(join(root, 'dist', executable), 'fixture only')
  writeFileSync(join(root, 'path.txt'), executable)
  const unexpected = () => assert.fail('already installed; no network or installer needed')
  await installElectron({ root, env: {}, canUseLocalProxy: unexpected, run: unexpected })
  writeFileSync(join(root, 'dist/version'), '43.0.0')
  assert.equal(isInstalled(root, {}), false)
})

test('explicit HTTP(S) proxies and bypass settings survive without local discovery', async () => {
  const env = { http_proxy: 'http://custom.invalid:8080', HTTPS_PROXY: 'http://secure.invalid:8081', NO_PROXY: 'internal.invalid' }
  const next = await downloadEnvironment(env, () => assert.fail('explicit proxy takes priority'))
  assert.equal(next.HTTP_PROXY, env.http_proxy)
  assert.equal(next.HTTPS_PROXY, env.HTTPS_PROXY)
  assert.equal(next.NO_PROXY, env.NO_PROXY)
  assert.equal(next.ELECTRON_GET_USE_PROXY, '1')
  assert.equal(next.NODE_USE_ENV_PROXY, '1')
  assert.equal(env.NODE_USE_ENV_PROXY, undefined)
  const npm = await downloadEnvironment({ npm_config_https_proxy: 'http://npm.invalid:8080' })
  assert.equal(npm.HTTPS_PROXY, 'http://npm.invalid:8080')
})

test('default local proxy is used only when its port is available; otherwise use direct', async () => {
  const proxied = await downloadEnvironment({}, async () => true)
  assert.equal(proxied.HTTPS_PROXY, LOCAL_PROXY)
  const direct = await downloadEnvironment({}, async () => false)
  assert.equal(direct.HTTPS_PROXY, undefined)
  assert.equal(direct.ELECTRON_GET_USE_PROXY, undefined)
})

test('failed default mirror retries official source with stale npm mirror aliases removed', async () => {
  const attempts = []
  await installElectron({
    root: join(tmpdir(), 'w2t-no-electron-fixture'),
    env: { npm_config_electron_mirror: DEFAULT_MIRROR, npm_package_config_electron_mirror: DEFAULT_MIRROR },
    canUseLocalProxy: async () => true,
    run: async (_, env) => { attempts.push(env); return attempts.length === 1 ? 1 : 0 },
    log() {}
  })
  assert.deepEqual(attempts.map(env => env.ELECTRON_MIRROR), [DEFAULT_MIRROR, OFFICIAL_MIRROR])
  assert.ok(attempts.every(env => env.HTTPS_PROXY === LOCAL_PROXY && !env.npm_config_electron_mirror && !env.npm_package_config_electron_mirror))
})

test('custom source overrides package default and failed installation remains a failure', async () => {
  const env = { ELECTRON_MIRROR: 'https://custom.invalid/electron', npm_package_config_electron_mirror: DEFAULT_MIRROR }
  assert.deepEqual(downloadMirrors(env), ['https://custom.invalid/electron/'])
  let attempts = 0
  await assert.rejects(installElectron({
    root: join(tmpdir(), 'w2t-no-electron-fixture'), env,
    canUseLocalProxy: async () => false,
    run: async () => { attempts++; return 1 }, log() {}
  }), /runtime installation failed/)
  assert.equal(attempts, 1)
})

test('network diagnostics include nested connection errors and omit URL credentials', () => {
  const error = new TypeError('fetch failed', { cause: new AggregateError([
    Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    new Error('https://user:secret@proxy.invalid/path?token=private#hidden')
  ], 'connection failed') })
  const text = safeError(error)
  assert.match(text, /fetch failed.*connection failed.*ECONNREFUSED/)
  assert.match(text, /https:\/\/proxy.invalid\/path/)
  assert.doesNotMatch(text, /secret|user|token|private|hidden/)
})
