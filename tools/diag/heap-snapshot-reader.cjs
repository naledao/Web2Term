// V8 emits a small object header followed by flat arrays. Stream those arrays
// independently so large source strings never have to be buffered or decoded.
const MAX_HEADER_CHARS = 64 * 1024
const MAX_TOKEN_CHARS = 256
const MAX_GRAPH_BYTES = 1024 ** 3
const LOCATION_BLOCK_SIZE = 16_384
const NO_STRING = 0xffffffff

class SnapshotReadError extends Error {
  constructor(code, details) {
    super(code)
    this.details = details
  }
}

function unsignedColumn(table, max) {
  return (value, offset) => {
    if (!(value >= 0 && value <= max)) return false
    table[offset] = value
    return true
  }
}

class HeapSnapshotReader {
  constructor(safeString) {
    this.safeString = safeString
    this.data = { strings: new Map() }
    this.section = 'header'
    this.header = ''
    this.key = ''
    this.token = ''
    this.quoted = false
    this.escaped = false
    this.depth = 0
    this.stringId = 0
    this.number = 0
    this.negative = false
    this.hasDigits = false
    this.offset = 0
    this.locationBlocks = []
  }

  push(chunk) {
    if (this.section === 'header') {
      this.header += chunk
      const start = /"nodes"\s*:\s*\[/.exec(this.header)
      if (!start) {
        if (this.header.length > MAX_HEADER_CHARS) throw new SnapshotReadError('snapshot-header-too-large')
        return
      }
      if (start.index > MAX_HEADER_CHARS) throw new SnapshotReadError('snapshot-header-too-large')
      const header = this.header.slice(0, start.index).trimEnd().replace(/,$/, '')
      this.data.snapshot = JSON.parse(header + '}').snapshot
      this.allocateGraph()
      chunk = this.header.slice(start.index + start[0].length)
      this.header = ''
      this.startSection('nodes')
    }
    let index = 0
    while (index < chunk.length) {
      switch (this.section) {
        case 'numbers':
          index = this.readNumbers(chunk, index)
          break
        case 'strings':
          index = this.readStrings(chunk, index)
          break
        case 'skip':
          index = this.skipArray(chunk, index)
          break
        default:
          index = this.readKey(chunk, index)
      }
    }
  }

  allocateGraph() {
    const { node_count: nodes, edge_count: edges, meta } = this.data.snapshot
    const nodeWidth = meta.node_fields.length
    const edgeWidth = meta.edge_fields.length
    if (!Number.isSafeInteger(nodes) || nodes < 1 || !Number.isSafeInteger(edges) || edges < 0 ||
        !nodeWidth || !edgeWidth || nodeWidth > 32 || edgeWidth > 32) {
      throw new SnapshotReadError('snapshot-schema-unsupported')
    }
    this.layout = { nodes, edges, estimatedGraphBytes: (nodes * nodeWidth + edges * edgeWidth) * 4 +
      nodes * 80 + 32 * 1024 ** 2 }
    if (this.layout.estimatedGraphBytes > MAX_GRAPH_BYTES) throw new SnapshotReadError('snapshot-graph-limit')
    this.data.nodes = new Uint32Array(nodes * nodeWidth)
    this.data.edges = new Uint32Array(edges * edgeWidth)
    this.data.nodeSizes = new Float64Array(nodes)

    // V8's flat rows contain several different kinds of numbers. The graph
    // needs indices, not object IDs or allocation-trace IDs. Treat edge
    // labels as optional and keep byte sizes at their original width.
    const nodesTable = this.data.nodes
    const edgesTable = this.data.edges
    const sizes = this.data.nodeSizes
    const storeString = (table, value, offset) => { table[offset] = value >= 0 && value < NO_STRING ? value : NO_STRING }
    this.columns = {
      nodes: meta.node_fields.map(name => {
        if (name === 'self_size') return (value, offset) => {
          sizes[Math.floor(offset / nodeWidth)] = Number.isFinite(value) && value >= 0 ? value : 0
          return true
        }
        if (name === 'name') return (value, offset) => { storeString(nodesTable, value, offset); return true }
        const max = name === 'type' ? meta.node_types[meta.node_fields.indexOf('type')].length - 1
          : name === 'edge_count' ? edges : name === 'detachedness' ? 2 : undefined
        return max === undefined ? null : unsignedColumn(nodesTable, max)
      }),
      edges: meta.edge_fields.map(name => {
        if (name === 'name_or_index') return (value, offset) => { storeString(edgesTable, value, offset); return true }
        if (name === 'type') {
          const max = meta.edge_types[meta.edge_fields.indexOf('type')].length - 1
          return unsignedColumn(edgesTable, max)
        }
        if (name === 'to_node') {
          const storeOffset = unsignedColumn(edgesTable, nodesTable.length - nodeWidth)
          return (value, offset) => value % nodeWidth === 0 && storeOffset(value, offset)
        }
        return null
      })
    }
  }

  startSection(name) {
    this.field = name
    this.offset = 0
    this.key = ''
    if (name === 'nodes' || name === 'edges' || name === 'locations') this.section = 'numbers'
    else if (name === 'strings') this.section = 'strings'
    else { this.section = 'skip'; this.depth = 1 }
  }

  readKey(chunk, index) {
    for (; index < chunk.length; index += 1) {
      const ch = chunk[index]
      if (this.section === 'done') {
        if (!/\s/.test(ch)) throw new SnapshotReadError('snapshot-trailing-data')
        continue
      }
      if (ch === '}' && /^\s*$/.test(this.key)) { this.section = 'done'; continue }
      this.key += ch
      if (this.key.length > MAX_TOKEN_CHARS) throw new SnapshotReadError('snapshot-schema-unsupported')
      if (ch !== '[') continue
      const name = /^\s*,\s*"([a-zA-Z0-9_]+)"\s*:\s*\[$/.exec(this.key)?.[1]
      if (!name) throw new SnapshotReadError('snapshot-schema-unsupported')
      this.startSection(name)
      return index + 1
    }
    return index
  }

  readNumbers(chunk, index) {
    const table = this.data[this.field]
    const columns = this.columns[this.field]
    let { number, negative, hasDigits, offset } = this
    for (; index < chunk.length; index += 1) {
      const code = chunk.charCodeAt(index)
      if (code >= 48 && code <= 57) {
        number = number * 10 + code - 48
        hasDigits = true
        continue
      }
      if (code === 45 && !hasDigits && !negative) { negative = true; continue }
      if (code !== 44 && code !== 93 && code !== 32 && !(code >= 9 && code <= 13)) {
        throw new SnapshotReadError('snapshot-invalid-number', { table: this.field, offset })
      }
      if (hasDigits) {
        if (table) {
          if (offset >= table.length) throw new SnapshotReadError('snapshot-extra-table-values', {
            table: this.field, row: Math.floor(offset / columns.length), offset
          })
          const column = offset % columns.length
          const store = columns[column]
          if (store && !store(negative ? -number : number, offset)) {
            throw new SnapshotReadError('snapshot-invalid-field', {
              table: this.field, row: Math.floor(offset / columns.length),
              column: this.data.snapshot.meta[this.field === 'nodes' ? 'node_fields' : 'edge_fields'][column]
            })
          }
        } else {
          if (number > 0x7fffffff || offset >= this.layout.nodes * 8) throw new SnapshotReadError('snapshot-location-limit')
          const inBlock = offset % LOCATION_BLOCK_SIZE
          if (!inBlock) this.locationBlocks.push(new Int32Array(LOCATION_BLOCK_SIZE))
          this.locationBlocks.at(-1)[inBlock] = negative ? -number : number
        }
        offset += 1
        number = 0
        negative = false
        hasDigits = false
      } else if (negative) {
        throw new SnapshotReadError('snapshot-invalid-number', { table: this.field, offset })
      }
      if (code !== 93) continue
      if (table && offset !== table.length) throw new SnapshotReadError('snapshot-incomplete-table', {
        table: this.field, offset, expectedValues: table.length
      })
      if (!table) this.locationLength = offset
      this.section = 'key'
      break
    }
    Object.assign(this, { number, negative, hasDigits, offset })
    return this.section === 'key' ? index + 1 : index
  }

  readStrings(chunk, index) {
    for (; index < chunk.length; index += 1) {
      const ch = chunk[index]
      if (this.quoted) {
        if (this.token !== null) this.token = this.token.length < MAX_TOKEN_CHARS ? this.token + ch : null
        if (this.escaped) { this.escaped = false; continue }
        if (ch === '\\') { this.escaped = true; continue }
        if (ch !== '"') continue
        this.quoted = false
        if (this.token !== null) {
          const safe = this.safeString(JSON.parse(this.token))
          if (safe) this.data.strings.set(this.stringId, safe)
        }
        this.stringId += 1
        continue
      }
      if (ch === '"') { this.quoted = true; this.token = '"'; continue }
      if (ch === ']') { this.section = 'key'; return index + 1 }
      if (ch !== ',' && !/\s/.test(ch)) throw new SnapshotReadError('snapshot-invalid-string-table')
    }
    return index
  }

  skipArray(chunk, index) {
    for (; index < chunk.length; index += 1) {
      const ch = chunk[index]
      if (this.quoted) {
        if (this.escaped) this.escaped = false
        else if (ch === '\\') this.escaped = true
        else if (ch === '"') this.quoted = false
      } else if (ch === '"') this.quoted = true
      else if (ch === '[' || ch === '{') this.depth += 1
      else if ((ch === ']' || ch === '}') && --this.depth === 0) {
        this.section = 'key'
        return index + 1
      }
    }
    return index
  }

  finish() {
    if (this.section !== 'done') throw new SnapshotReadError('snapshot-incomplete-stream')
    const locations = new Int32Array(this.locationLength ?? 0)
    for (const [i, block] of this.locationBlocks.entries()) {
      const offset = i * LOCATION_BLOCK_SIZE
      locations.set(block.subarray(0, locations.length - offset), offset)
    }
    this.locationBlocks.length = 0
    return { ...this.data, locations }
  }
}

module.exports = { HeapSnapshotReader, SnapshotReadError }
