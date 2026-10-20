// User-run offline regressions. No Electron, database connection or network.
// Run: node --test tests/mysql-column-metadata.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

function load(relative, dependencies = {}) {
  const exports = {}
  const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  new Script(compiled).runInNewContext({
    exports, Buffer,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency: ${name}`)
      return dependencies[name]
    }
  })
  return exports
}

const fieldValues = load('../src/main/mysql-field-value.ts')
const { readMysqlColumnMetadata, mysqlColumnDescriptions } = load('../src/main/mysql-table-rows.ts', {
  './mysql-field-value': fieldValues
})
const definition = (name, dataType, columnType, extra = {}) => ({
  name, dataType, columnType, comment: `${name} 注释`, tableType: 'BASE TABLE',
  columnKey: '', numericPrecision: null, numericScale: null, extra: '', ...extra
})
const read = (rows) => readMysqlColumnMetadata({ async query() { return [rows, []] } }, 'app', 'items')

test('full types preserve character length, numeric precision, unsigned and timestamp precision', async () => {
  const rows = [
    definition('name', 'varchar', 'varchar(500)'),
    definition('amount', 'decimal', 'decimal(10,2)', { numericPrecision: 10, numericScale: 2 }),
    definition('id', 'bigint', 'bigint unsigned'),
    definition('flag', 'bit', 'bit(1)'),
    definition('created_at', 'datetime', 'datetime(6)'),
    definition('payload', 'json', 'json')
  ]
  const metadata = await read(rows)
  assert.deepEqual(Array.from(metadata, (column) => column.columnType), rows.map((row) => row.columnType))
  assert.equal(metadata[1].dataType, 'decimal', 'full display types must not replace the basic type used for row editing')
  assert.equal(metadata[1].numericPrecision, 10)
  assert.equal(metadata[1].numericScale, 2)
})

test('enum and set value spelling, case and SQL escaping remain exactly as the server returned them', async () => {
  const rows = [
    definition('status', 'ENUM', "enum('Ready','Hold','O''Brien')"),
    definition('tags', 'SET', "set('First','第二项')")
  ]
  const metadata = await read(rows)
  assert.equal(metadata[0].columnType, rows[0].columnType)
  assert.equal(metadata[1].columnType, rows[1].columnType)
  assert.equal(metadata[0].dataType, 'enum')
})

test('the existing metadata query reads COLUMN_TYPE with the same bound schema/table parameters', async () => {
  const queries = []
  const database = 'app`name'
  const table = "items' OR 1=1 --"
  await readMysqlColumnMetadata({ async query(query) { queries.push(query); return [[], []] } }, database, table)
  assert.equal(queries.length, 1)
  assert.match(queries[0].sql, /c\.COLUMN_TYPE AS columnType/)
  assert.match(queries[0].sql, /c\.COLUMN_COMMENT AS comment/)
  assert.match(queries[0].sql, /WHERE c\.TABLE_SCHEMA = \? AND c\.TABLE_NAME = \?/)
  assert.deepEqual(Array.from(queries[0].values), [database, table])
  assert.equal(queries[0].timeout, 8000)
})

test('field types and comments align to returned column names instead of metadata row order', async () => {
  const metadata = await read([
    definition('amount', 'decimal', 'decimal(10,2)'),
    definition('name', 'varchar', 'varchar(500)'),
    definition('id', 'bigint', 'bigint unsigned')
  ])
  const details = mysqlColumnDescriptions(['id', 'missing', 'name', 'amount'], metadata)
  assert.deepEqual(Array.from(details.columnTypes), ['bigint unsigned', '', 'varchar(500)', 'decimal(10,2)'])
  assert.deepEqual(Array.from(details.columnComments), ['id 注释', '', 'name 注释', 'amount 注释'])
})

test('views and tables without primary keys still expose field descriptions', async () => {
  const metadata = await read([definition('name', 'varchar', 'varchar(255)', { tableType: 'VIEW' })])
  const details = mysqlColumnDescriptions(['name'], metadata)
  assert.deepEqual(Array.from(details.columnTypes), ['varchar(255)'])
  assert.deepEqual(Array.from(details.columnComments), ['name 注释'])
})

test('missing metadata remains an aligned empty value rather than an invented SQL type', async () => {
  const metadata = await read([
    definition('name', 'varchar', null),
    definition('unknown', null, null, { comment: null })
  ])
  const details = mysqlColumnDescriptions(['name', 'unknown', 'missing'], metadata)
  assert.deepEqual(Array.from(details.columnTypes), ['varchar', '', ''])
  assert.deepEqual(Array.from(mysqlColumnDescriptions(['id', 'name'], []).columnTypes), ['', ''])
  assert.equal((await read(null)).length, 0)
})

test('metadata permission or connection failures propagate to the caller for its non-fatal warning', async () => {
  await assert.rejects(readMysqlColumnMetadata({
    async query() { throw new Error('metadata permission denied') }
  }, 'app', 'items'), /metadata permission denied/)
})
