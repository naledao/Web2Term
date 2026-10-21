import type { Connection } from 'mysql2/promise'

function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.trim() === '' || name.includes('\0')) throw new Error('数据库或表名无效。')
  return '`' + name.replace(/`/g, '``') + '`'
}

/** Only change the CREATE prefix; comments, indexes and table options stay intact. */
export function mysqlCreateTableIfNotExists(ddl: string): string {
  const statement = ddl.trim()
  if (!/^CREATE\s+TABLE\s+/i.test(statement)) throw new Error('服务器未返回有效的 CREATE TABLE 语句。')
  return statement
    .replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?/i, 'CREATE TABLE IF NOT EXISTS ')
    .replace(/;$/, '') + ';'
}

/** Read all base tables through one connection; never return an incomplete export. */
export async function readMysqlDatabaseDdl(
  connection: Pick<Connection, 'query'>, database: string
): Promise<{ sql: string; tableCount: number }> {
  quoteIdentifier(database)
  const [rows] = await connection.query({
    sql: "SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    values: [database], timeout: 8000
  })
  const tables = (Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []).map((row) => {
    if (typeof row.TABLE_NAME !== 'string') throw new Error('服务器返回的表名无效。')
    return row.TABLE_NAME
  })
  if (tables.length === 0) throw new Error('这个数据库里没有可导出的数据表（不包含视图）。')

  const statements: string[] = []
  for (const table of tables) {
    try {
      const [result] = await connection.query({
        sql: `SHOW CREATE TABLE ${quoteIdentifier(database)}.${quoteIdentifier(table)}`,
        timeout: 8000
      })
      const row = Array.isArray(result) ? result[0] as Record<string, unknown> | undefined : undefined
      const ddl = row?.['Create Table']
      if (typeof ddl !== 'string' || ddl.trim() === '') throw new Error('服务器未返回该表的 DDL。')
      statements.push(mysqlCreateTableIfNotExists(ddl))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`读取表 ${JSON.stringify(table)} 的 DDL 失败：${message}`)
    }
  }

  return {
    tableCount: statements.length,
    sql: [
      '-- MySQL table DDL export',
      `-- Source database: ${JSON.stringify(database)}`,
      `-- Tables: ${statements.length}; views and row data are not included.`,
      '-- Select the target database before running this file.',
      '',
      // Tables can reference a later table, or each other. Restore the caller's setting.
      'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS;',
      'SET FOREIGN_KEY_CHECKS = 0;',
      '',
      statements.join('\n\n'),
      '',
      'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;',
      ''
    ].join('\n')
  }
}
