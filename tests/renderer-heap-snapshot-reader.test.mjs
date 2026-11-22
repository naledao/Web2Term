import assert from 'node:assert/strict'
import test from 'node:test'
import heapSnapshotReader from '../tools/diag/heap-snapshot-reader.cjs'

const { HeapSnapshotReader, SnapshotReadError } = heapSnapshotReader
const nodeFields = ['type', 'name', 'id', 'self_size', 'edge_count', 'trace_node_id', 'detachedness']
const wideSize = 2 ** 32 + 63

function fixture(target = nodeFields.length) {
  return JSON.stringify({
    snapshot: {
      node_count: 2,
      edge_count: 1,
      meta: {
        node_fields: nodeFields,
        node_types: [['synthetic', 'native'], 'string', 'number', 'number', 'number', 'number', 'number'],
        edge_fields: ['type', 'name_or_index', 'to_node'],
        edge_types: [['hidden'], 'string_or_number', 'node']
      }
    },
    nodes: [0, 0, 1, 0, 1, 0, 0, 1, 1, 2, wideSize, 0, -1, 2],
    edges: [0, -17, target],
    trace_tree: [1, [2, ['delimiter inside a string: "]']]],
    locations: [nodeFields.length, 18, -1, 9],
    strings: ['(root)', 'HTMLDivElement', 'private'.repeat(100), 'callback']
  })
}

function readInChunks(source, length) {
  const reader = new HeapSnapshotReader(name => ['HTMLDivElement', 'callback'].includes(name) ? name : null)
  for (let offset = 0; offset < source.length; offset += length) reader.push(source.slice(offset, offset + length))
  return reader.finish()
}

test('reads wide sizes and signed optional values across snapshot chunks', () => {
  for (const length of [1, 17, 256]) {
    const result = readInChunks(fixture(), length)
    assert.deepEqual([...result.nodeSizes], [0, wideSize])
    assert.equal(result.nodes[nodeFields.length + 6], 2)
    assert.equal(result.edges[2], nodeFields.length)
    assert.deepEqual([...result.locations], [nodeFields.length, 18, -1, 9])
    assert.deepEqual([...result.strings], [[1, 'HTMLDivElement'], [3, 'callback']])
  }
})

test('reports the table and column when a required graph offset is invalid', () => {
  assert.throws(() => readInChunks(fixture(nodeFields.length + 1), 3), error => {
    assert.ok(error instanceof SnapshotReadError)
    assert.equal(error.message, 'snapshot-invalid-field')
    assert.deepEqual(error.details, { table: 'edges', row: 0, column: 'to_node' })
    return true
  })
})
