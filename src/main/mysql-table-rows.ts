import type { Connection, ResultSetHeader } from 'mysql2/promise'
import type { MysqlCellUpdateResult, MysqlRowKey, MysqlRowDeleteResult } from '../shared/types'
import { formatMysqlCell } from './mysql-field-value'

export interface MysqlColumnMetadata {
  name: string
  comment: string
  columnKey: string
  tableType: string
  dataType: string
  /** Full server definition, including length, precision, unsigned and enum values. */
  columnType: string
  numericPrecision: number
  numericScale: number
  /** INFORMATION_SCHEMA EXTRA, e.g. 'auto_increment' or 'VIRTUAL GENERATED'. */
  extra: string
}

type MysqlRowConnection = Pick<Connection, 'query' | 'execute'>
const INTEGER_TYPES = new Set(['tinyint', 'smallint', 'mediumint', 'int', 'bigint', 'year'])
const BINARY_TYPES = new Set(['binary', 'varbinary', 'tinyblob', 'blob', 'mediumblob', 'longblob', 'bit'])
const SPATIAL_TYPES = new Set(['geometry', 'point', 'linestring', 'polygon', 'multipoint', 'multilinestring', 'multipolygon', 'geometrycollection', 'geomcollection'])

export async function readMysqlColumnMetadata(
  connection: Pick<Connection, 'query'>, database: string, table: string
): Promise<MysqlColumnMetadata[]> {
  const [rows] = await connection.query({
    sql: `SELECT c.COLUMN_NAME AS name, c.COLUMN_COMMENT AS comment, c.COLUMN_KEY AS columnKey,
      c.DATA_TYPE AS dataType, c.COLUMN_TYPE AS columnType,
      c.NUMERIC_PRECISION AS numericPrecision, c.NUMERIC_SCALE AS numericScale,
      c.EXTRA AS extra, t.TABLE_TYPE AS tableType
      FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME
      WHERE c.TABLE_SCHEMA = ? AND c.TABLE_NAME = ? ORDER BY c.ORDINAL_POSITION`,
    values: [database, table], timeout: 8000
  })
  return (Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []).map((row) => ({
    name: String(row.name ?? ''), comment: String(row.comment ?? ''), columnKey: String(row.columnKey ?? ''),
    tableType: String(row.tableType ?? ''), dataType: String(row.dataType ?? '').toLowerCase(),
    columnType: String(row.columnType || row.dataType || ''),
    numericPrecision: Number(row.numericPrecision), numericScale: Number(row.numericScale),
    extra: String(row.extra ?? '')
  }))
}

/** Align field details by name rather than relying on the metadata query's order. */
export function mysqlColumnDescriptions(
  columns: readonly string[], metadata: readonly MysqlColumnMetadata[]
): { columnComments: string[]; columnTypes: string[] } {
  const byName = new Map(metadata.map((column) => [column.name, column]))
  return {
    columnComments: columns.map((name) => byName.get(name)?.comment ?? ''),
    columnTypes: columns.map((name) => byName.get(name)?.columnType ?? '')
  }
}

export function mysqlRowDeleteUnavailable(metadata: readonly MysqlColumnMetadata[]): string {
  if (metadata.length === 0) return '未读取到表的主键信息，暂不支持删除记录。'
  if (metadata.some((column) => column.tableType !== 'BASE TABLE')) return '视图暂不支持删除记录。'
  if (!metadata.some((column) => column.columnKey === 'PRI')) return '该表没有主键，暂不支持删除记录。'
  if (metadata.some((column) => column.columnKey === 'PRI' && (column.dataType === 'float' || column.dataType === 'double'))) {
    return '浮点主键无法可靠定位记录，暂不支持删除。'
  }
  return ''
}

/**
 * Why one column cannot be edited in place, or '' when it can.
 *
 * Binary and spatial values are shown as placeholders (`<n bytes>`), so writing the shown
 * text back would destroy them; generated columns are computed by the server.
 */
export function mysqlColumnEditUnavailable(column: MysqlColumnMetadata | undefined): string {
  if (!column) return '字段已不存在，请刷新表数据。'
  if (BINARY_TYPES.has(column.dataType)) return '二进制字段不支持直接编辑。'
  if (SPATIAL_TYPES.has(column.dataType)) return '空间字段不支持直接编辑。'
  if (/\bGENERATED\b/i.test(column.extra)) return '生成列由数据库计算，不能直接编辑。'
  return ''
}

/** Per column: can a cell be edited in place? All false when rows have no usable key. */
export function mysqlColumnsEditable(columns: readonly string[], metadata: readonly MysqlColumnMetadata[]): boolean[] {
  if (mysqlRowDeleteUnavailable(metadata) !== '') return columns.map(() => false)
  return columns.map((name) => mysqlColumnEditUnavailable(metadata.find((entry) => entry.name === name)) === '')
}

export function mysqlRowKey(row: Record<string, unknown>, metadata: readonly MysqlColumnMetadata[]): MysqlRowKey | null {
  if (mysqlRowDeleteUnavailable(metadata) !== '') return null
  const key: MysqlRowKey = []
  for (const column of metadata.filter((entry) => entry.columnKey === 'PRI')) {
    const value = row[column.name]
    if (Buffer.isBuffer(value)) key.push({ column: column.name, value: value.toString('hex'), encoding: 'hex' })
    else if (typeof value === 'string') key.push({ column: column.name, value, encoding: 'text' })
    else if (typeof value === 'number' && Number.isFinite(value)
      && (!INTEGER_TYPES.has(column.dataType) || Number.isSafeInteger(value))) {
      key.push({ column: column.name, value: String(value), encoding: 'text' })
    } else return null
  }
  return key
}

function quoteIdentifier(name: string): string {
  if (typeof name !== 'string' || name.trim() === '' || name.includes('\0')) throw new Error('数据库或表名无效。')
  return '`' + name.replace(/`/g, '``') + '`'
}

/** Build `pk1 = ? AND pk2 = ?` for one complete primary key, checked against server metadata. */
function buildMysqlRowKeyCondition(
  key: unknown, metadata: readonly MysqlColumnMetadata[], action: string
): { condition: string; values: Array<string | Buffer> } {
  const unavailable = mysqlRowDeleteUnavailable(metadata)
  if (unavailable) throw new Error(unavailable.replace('删除', action))
  const primary = metadata.filter((column) => column.columnKey === 'PRI')
  if (!Array.isArray(key) || key.length !== primary.length) throw new Error(`${action}需要完整的主键，请刷新表数据后重试。`)
  const parts = new Map<string, { value: string; encoding: 'text' | 'hex' }>()
  for (const part of key) {
    if (!part || typeof part.column !== 'string' || typeof part.value !== 'string'
      || (part.encoding !== 'text' && part.encoding !== 'hex') || parts.has(part.column)) {
      throw new Error('主键数据无效，请刷新表数据后重试。')
    }
    parts.set(part.column, part)
  }
  const values: Array<string | Buffer> = []
  const conditions = primary.map((column) => {
    const part = parts.get(column.name)
    if (!part) throw new Error('表的主键已变化，请刷新表数据后重试。')
    const identifier = quoteIdentifier(column.name)
    if (BINARY_TYPES.has(column.dataType)) {
      if (part.encoding !== 'hex' || !/^(?:[0-9a-fA-F]{2})*$/.test(part.value)) throw new Error('二进制主键数据无效。')
      if (column.dataType === 'bit') {
        if (part.value.length > 16 || part.value === '') throw new Error('BIT 主键数据无效。')
        values.push(part.value)
        return `${identifier} = CAST(CONV(?, 16, 10) AS UNSIGNED)`
      }
      values.push(Buffer.from(part.value, 'hex'))
      return `${identifier} = ?`
    }
    if (part.encoding !== 'text') throw new Error('主键类型已变化，请刷新表数据后重试。')
    values.push(part.value)
    if (INTEGER_TYPES.has(column.dataType)) {
      if (!/^-?\d+$/.test(part.value)) throw new Error('整数主键数据无效。')
      // Explicit decimal comparison preserves BIGINT identities beyond JavaScript/double precision.
      return `${identifier} = CAST(? AS DECIMAL(65, 0))`
    }
    if (column.dataType === 'decimal') {
      const precision = column.numericPrecision, scale = column.numericScale
      if (!Number.isInteger(precision) || precision < 1 || precision > 65 || !Number.isInteger(scale)
        || scale < 0 || scale > 30 || scale > precision || !/^-?\d+(?:\.\d+)?$/.test(part.value)) {
        throw new Error('DECIMAL 主键数据无效。')
      }
      return `${identifier} = CAST(? AS DECIMAL(${precision}, ${scale}))`
    }
    return `${identifier} = ?`
  })
  return { condition: conditions.join(' AND '), values }
}

export function buildMysqlRowDeleteQuery(
  database: string, table: string, key: unknown, metadata: readonly MysqlColumnMetadata[]
): { sql: string; values: Array<string | Buffer> } {
  const { condition, values } = buildMysqlRowKeyCondition(key, metadata, '删除')
  return {
    sql: `DELETE FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)} WHERE ${condition} LIMIT 1`,
    values
  }
}

/** One `UPDATE ... SET column = ? WHERE <primary key> LIMIT 1`; null writes SQL NULL. */
export function buildMysqlRowUpdateQuery(
  database: string, table: string, key: unknown, column: string, value: unknown, metadata: readonly MysqlColumnMetadata[]
): { sql: string; values: Array<string | Buffer | null> } {
  if (value !== null && typeof value !== 'string') throw new Error('字段值无效。')
  const unavailable = mysqlColumnEditUnavailable(metadata.find((entry) => entry.name === column))
  if (unavailable) throw new Error(unavailable)
  const { condition, values } = buildMysqlRowKeyCondition(key, metadata, '更新')
  return {
    sql: `UPDATE ${quoteIdentifier(database)}.${quoteIdentifier(table)} SET ${quoteIdentifier(column)} = ? WHERE ${condition} LIMIT 1`,
    values: [value, ...values]
  }
}

/** Validate against current server metadata; never accept SQL or a WHERE clause from the renderer. */
export async function deleteMysqlRowWithConnection(
  connection: MysqlRowConnection, database: string, table: string, key: unknown
): Promise<MysqlRowDeleteResult> {
  const metadata = await readMysqlColumnMetadata(connection, database, table)
  const query = buildMysqlRowDeleteQuery(database, table, key, metadata)
  const [result] = await connection.execute<ResultSetHeader>({ ...query, timeout: 8000 })
  return result.affectedRows === 1
    ? { ok: true, affectedRows: 1, message: '已删除 1 条记录。' }
    : { ok: false, affectedRows: result.affectedRows, message: '记录已不存在或主键已变化，请刷新表数据。' }
}

/**
 * Update one cell, then read the row back so the grid shows what the server stored
 * (type coercion, truncation, ON UPDATE timestamps) rather than what was typed.
 *
 * mysql2 connects with FOUND_ROWS, so affectedRows counts the matched row even when the
 * value did not change; 0 really means the row is gone or its key changed.
 */
export async function updateMysqlCellWithConnection(
  connection: MysqlRowConnection, database: string, table: string, key: unknown, column: string, value: unknown
): Promise<MysqlCellUpdateResult> {
  const metadata = await readMysqlColumnMetadata(connection, database, table)
  const query = buildMysqlRowUpdateQuery(database, table, key, column, value, metadata)
  const [result] = await connection.execute<ResultSetHeader>({ ...query, timeout: 8000 })
  if (result.affectedRows !== 1) {
    return { ok: false, message: '记录已不存在或主键已变化，请刷新表数据。', columns: [], row: null, rowKey: null }
  }
  // Editing a primary-key column moves the row; look it up again by its new key.
  const nextKey = (key as MysqlRowKey).map((part) =>
    part.column === column && typeof value === 'string' ? { ...part, value } : part
  )
  try {
    const { condition, values } = buildMysqlRowKeyCondition(nextKey, metadata, '读取')
    const [rows, fields] = await connection.query({
      sql: `SELECT * FROM ${quoteIdentifier(database)}.${quoteIdentifier(table)} WHERE ${condition} LIMIT 1`,
      values, timeout: 8000
    })
    const record = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined
    if (!record) return { ok: true, message: '', columns: [], row: null, rowKey: null }
    const columns = (fields ?? []).map((field) => field.name)
    return {
      ok: true,
      message: '',
      columns,
      row: columns.map((name, index) => formatMysqlCell(record[name], fields?.[index])),
      rowKey: mysqlRowKey(record, metadata)
    }
  } catch {
    // The update itself went through; with no row to show, the caller reloads the page.
    return { ok: true, message: '', columns: [], row: null, rowKey: null }
  }
}
