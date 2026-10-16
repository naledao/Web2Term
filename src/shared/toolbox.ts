import { IpcChannels } from './types'

/** Explicit allowlist: retained tool pages can only address these session operations. */
export const TOOLBOX_METHODS = {
  getGitLog: IpcChannels.gitLog,
  getGitDiff: IpcChannels.gitDiff,
  listMysqlConnections: IpcChannels.mysqlConnList,
  saveMysqlConnection: IpcChannels.mysqlConnSave,
  listMysqlDatabases: IpcChannels.mysqlConnListDatabases,
  listMysqlTables: IpcChannels.mysqlConnListTables,
  queryMysqlTable: IpcChannels.mysqlConnQueryTable,
  deleteMysqlTableRow: IpcChannels.mysqlConnDeleteRow,
  executeMysqlSql: IpcChannels.mysqlConnExecuteSql,
  createMysqlTable: IpcChannels.mysqlConnCreateTable,
  getMysqlTableDdl: IpcChannels.mysqlConnTableDdl,
  removeMysqlConnection: IpcChannels.mysqlConnRemove,
  listRedisConnections: IpcChannels.redisConnList,
  saveRedisConnection: IpcChannels.redisConnSave,
  removeRedisConnection: IpcChannels.redisConnRemove,
  testRedisConnection: IpcChannels.redisTestConnection,
  scanRedisKeys: IpcChannels.redisScanKeys,
  readRedisKey: IpcChannels.redisReadKey,
  listNacosConnections: IpcChannels.nacosConnList,
  saveNacosConnection: IpcChannels.nacosConnSave,
  removeNacosConnection: IpcChannels.nacosConnRemove,
  openNacosView: IpcChannels.nacosOpen,
  navigateNacos: IpcChannels.nacosNavigate,
  closeNacosView: IpcChannels.nacosClose,
  getNacosState: IpcChannels.nacosGetState
} as const

export type ToolboxMethod = keyof typeof TOOLBOX_METHODS
export interface ToolboxInvocation {
  sessionId: string
  method: ToolboxMethod
  args: unknown[]
}
