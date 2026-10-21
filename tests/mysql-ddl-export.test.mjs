// User-run offline regressions. No Electron, database connection or network.
// Run: node --test tests/mysql-ddl-export.test.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script } from 'node:vm'
import ts from 'typescript'

const exports = {}
const source = readFileSync(new URL('../src/main/mysql-ddl-export.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
new Script(compiled).runInNewContext({ exports })
const { mysqlCreateTableIfNotExists, readMysqlDatabaseDdl } = exports

test('add IF NOT EXISTS without changing columns, indexes, comments or table options', () => {
  const body = "`订单` (\n  `id` bigint unsigned NOT NULL,\n  `note` varchar(255) DEFAULT 'CREATE TABLE text',\n  PRIMARY KEY (`id`),\n  KEY `idx_note` (`note`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='订单表; 保留注释'"
  assert.equal(mysqlCreateTableIfNotExists(`CREATE TABLE ${body}`), `CREATE TABLE IF NOT EXISTS ${body};`)
})

test('existing IF NOT EXISTS and a terminating semicolon remain valid without duplication', () => {
  assert.equal(
    mysqlCreateTableIfNotExists('  create\n table if not exists `items` (`id` int);\n'),
    'CREATE TABLE IF NOT EXISTS `items` (`id` int);'
  )
  assert.throws(() => mysqlCreateTableIfNotExists('CREATE VIEW `items` AS SELECT 1'), /CREATE TABLE/)
})

test('export reads every base table with bound database name and quoted identifiers', async () => {
  const queries = []
  const database = 'app`name'
  const definitions = [
    'CREATE TABLE `a``b` (`id` int PRIMARY KEY)',
    'CREATE TABLE `child` (`parent_id` int, FOREIGN KEY (`parent_id`) REFERENCES `a``b` (`id`))'
  ]
  const result = await readMysqlDatabaseDdl({
    async query(query) {
      queries.push(query)
      if (queries.length === 1) return [[{ TABLE_NAME: 'a`b' }, { TABLE_NAME: 'child' }], []]
      return [[{ 'Create Table': definitions[queries.length - 2] }], []]
    }
  }, database)
  assert.equal(queries.length, 3)
  assert.deepEqual(Array.from(queries[0].values), [database])
  assert.match(queries[0].sql, /TABLE_TYPE = 'BASE TABLE'/)
  assert.match(queries[0].sql, /ORDER BY TABLE_NAME/)
  assert.equal(queries[1].sql, 'SHOW CREATE TABLE `app``name`.`a``b`')
  assert.equal(queries[2].sql, 'SHOW CREATE TABLE `app``name`.`child`')
  assert.equal(result.tableCount, 2)
  for (const ddl of definitions) assert.ok(result.sql.includes(mysqlCreateTableIfNotExists(ddl)))
  assert.ok(result.sql.indexOf('SET FOREIGN_KEY_CHECKS = 0;') < result.sql.indexOf('CREATE TABLE'))
  assert.ok(result.sql.indexOf('SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS;') > result.sql.lastIndexOf('CREATE TABLE'))
  assert.doesNotMatch(result.sql, /\b(?:DROP TABLE|INSERT INTO|CREATE DATABASE|USE)\b/)
})

test('large schemas export all tables rather than applying a page or search limit', async () => {
  const tables = Array.from({ length: 345 }, (_, index) => `table_${String(index).padStart(3, '0')}`)
  let queryCount = 0
  const result = await readMysqlDatabaseDdl({
    async query() {
      const index = queryCount++
      return index === 0
        ? [tables.map((TABLE_NAME) => ({ TABLE_NAME })), []]
        : [[{ 'Create Table': `CREATE TABLE \`${tables[index - 1]}\` (\`备注\` text COMMENT '中文')` }], []]
    }
  }, '生产库')
  assert.equal(result.tableCount, 345)
  assert.equal(queryCount, 346)
  assert.equal((result.sql.match(/^CREATE TABLE IF NOT EXISTS /gm) ?? []).length, 345)
  assert.ok(result.sql.includes('CREATE TABLE IF NOT EXISTS `table_344` (`备注` text COMMENT \'中文\');'))
})

test('an empty database or a view-only database reports that there is nothing to export', async () => {
  await assert.rejects(readMysqlDatabaseDdl({ async query() { return [[], []] } }, 'app'), /没有可导出的数据表/)
})

test('a failure after reading one table rejects the entire export with the failing table name', async () => {
  let queryCount = 0
  await assert.rejects(readMysqlDatabaseDdl({
    async query() {
      queryCount++
      if (queryCount === 1) return [[{ TABLE_NAME: 'first' }, { TABLE_NAME: 'denied' }, { TABLE_NAME: 'last' }], []]
      if (queryCount === 2) return [[{ 'Create Table': 'CREATE TABLE `first` (`id` int)' }], []]
      throw new Error('SHOW command denied')
    }
  }, 'app'), /读取表 "denied" 的 DDL 失败：[\s\S]*SHOW command denied/)
  assert.equal(queryCount, 3)
})

test('a table replaced by a view during export cannot silently produce an incomplete schema', async () => {
  let queryCount = 0
  await assert.rejects(readMysqlDatabaseDdl({
    async query() {
      return queryCount++ === 0
        ? [[{ TABLE_NAME: 'changed' }], []]
        : [[{ 'Create View': 'CREATE VIEW `changed` AS SELECT 1' }], []]
    }
  }, 'app'), /读取表 "changed" 的 DDL 失败/)
})

test('database line breaks stay inside the export header comment', async () => {
  let queryCount = 0
  const result = await readMysqlDatabaseDdl({
    async query() {
      return queryCount++ === 0
        ? [[{ TABLE_NAME: 'items' }], []]
        : [[{ 'Create Table': 'CREATE TABLE `items` (`id` int)' }], []]
    }
  }, 'app\nDROP DATABASE other;\r')
  assert.ok(result.sql.includes('-- Source database: "app\\nDROP DATABASE other;\\r"\n'))
  assert.doesNotMatch(result.sql, /^DROP DATABASE/gm)
})
