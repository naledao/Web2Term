import type { AppApi } from '@shared/types'
import { TOOLBOX_METHODS } from '@shared/toolbox'
import type { ToolboxMethod } from '@shared/toolbox'

/** Use a fresh target: Electron's contextBridge freezes its exported API object. */
export function createToolSessionApi(api: AppApi, sessionId: string): AppApi {
  return new Proxy({ ...api }, {
    get(target, key: keyof AppApi) {
      if (Object.hasOwn(TOOLBOX_METHODS, key)) {
        return (...args: unknown[]) => api.invokeToolbox({ sessionId, method: key as ToolboxMethod, args })
      }
      if (key === 'setNacosBounds') return (bounds: Parameters<AppApi['setNacosBounds']>[0]) => api.setNacosBounds(bounds, sessionId)
      if (key === 'setNacosVisible') return (visible: boolean) => api.setNacosVisible(visible, sessionId)
      if (key === 'sendNacosCommand') return (command: Parameters<AppApi['sendNacosCommand']>[0]) => api.sendNacosCommand(command, sessionId)
      if (key === 'onMysqlConnectionChanged') return (listener: Parameters<AppApi['onMysqlConnectionChanged']>[0]) => api.onMysqlConnectionChanged(listener, sessionId)
      if (key === 'onRedisConnectionChanged') return (listener: Parameters<AppApi['onRedisConnectionChanged']>[0]) => api.onRedisConnectionChanged(listener, sessionId)
      if (key === 'onNacosConnectionChanged') return (listener: Parameters<AppApi['onNacosConnectionChanged']>[0]) => api.onNacosConnectionChanged(listener, sessionId)
      if (key === 'onNacosState') return (listener: Parameters<AppApi['onNacosState']>[0]) => api.onNacosState(listener, sessionId)
      return target[key]
    }
  })
}
