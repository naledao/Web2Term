// Only aggregate metadata is returned from this worker.
const { parentPort } = require('node:worker_threads')
const { HeapSnapshotReader, SnapshotReadError } = require('./heap-snapshot-reader.cjs')

const PATHS_PER_GROUP = 24
const MAX_PATH_STEPS = 14
const ATTACHED = 1
const DETACHED = 2
const SAFE_NAMES = new Set([
  '', '(GC roots)', '(Global handles)', '(Stack roots)', '(Strong roots)',
  'Array', 'Map', 'Set', 'WeakMap', 'Promise', 'Object', 'FiberNode', 'system / Context'
])
const SAFE_EDGES = new Set([
  'window', 'global', 'context', 'callback', 'listener', 'next', 'current', 'child', 'sibling',
  'alternate', 'stateNode', 'memoizedState', 'memoizedProps', 'return', 'elements', 'table',
  'parentNode', 'ownerDocument', 'reportedHistoryMarkdown'
])

function domGroup(name) {
  const type = name.replace(/^Detached /, '')
  if (/^(?:#document|(?:HTML|XML)?Document)(?:$|\s\()/i.test(type)) return 'Document'
  if (/^(?:#document-fragment|DocumentFragment)(?:$|\s\()/i.test(type)) return 'DocumentFragment'
  if (/^(?:ShadowRoot|#shadow-root)(?:$|\s\()/i.test(type)) return 'ShadowRoot'
  if (/^(?:Text|#text|Comment|#comment)(?:$|\s\()/i.test(type)) return 'Text or comment'
  if (/^(?:HTML|SVG|MathML)[A-Za-z0-9]*Element(?:$|\s\()/.test(type) ||
      /^(?:Element|HTMLElement|SVGElement)(?:$|\s\()/.test(type) || /^<[a-z][a-z0-9-]*[\s>]/.test(type)) return 'Element'
  return null
}

function isWindowName(name) {
  return /^Window(?:$| \/| \[JSGlobal(?:Object|Proxy)\])/.test(name)
}

function safeSnapshotString(name) {
  if (SAFE_NAMES.has(name) || SAFE_EDGES.has(name)) return name
  if (isWindowName(name)) return 'Window'
  const group = domGroup(name)
  return group === 'Text or comment' ? 'Text' : group
}

function summarize(data) {
  const { snapshot, nodes, nodeSizes, edges, strings } = data
  const meta = snapshot.meta
  const nodeWidth = meta.node_fields.length
  const edgeWidth = meta.edge_fields.length
  const nodeCount = snapshot.node_count
  const edgeCount = snapshot.edge_count
  const n = Object.fromEntries(meta.node_fields.map((name, index) => [name, index]))
  const e = Object.fromEntries(meta.edge_fields.map((name, index) => [name, index]))
  if (nodes.length !== nodeCount * nodeWidth || edges.length !== edgeCount * edgeWidth ||
      [n.type, n.name, n.edge_count, n.self_size, n.detachedness, e.type, e.name_or_index, e.to_node]
        .some(index => index === undefined)) return { error: 'snapshot-schema-unsupported' }

  const nodeTypes = meta.node_types[n.type]
  const edgeTypes = meta.edge_types[e.type]
  const nativeType = nodeTypes.indexOf('native')
  const weak = edgeTypes.indexOf('weak')
  const hidden = edgeTypes.indexOf('hidden')
  const invisible = edgeTypes.indexOf('invisible')
  const shortcut = edgeTypes.indexOf('shortcut')
  const nameOf = node => strings.get(nodes[node * nodeWidth + n.name]) || ''
  const typeOf = node => nodes[node * nodeWidth + n.type]
  const targetOf = edge => edges[edge + e.to_node] / nodeWidth
  const starts = new Uint32Array(nodeCount + 1)
  const states = new Uint8Array(nodeCount)
  const windows = []
  for (let node = 0; node < nodeCount; node += 1) {
    const index = node * nodeWidth
    starts[node + 1] = starts[node] + nodes[index + n.edge_count] * edgeWidth
    if (typeOf(node) === nativeType) states[node] = nodes[index + n.detachedness]
    if (nodeTypes[typeOf(node)] === 'object' && isWindowName(nameOf(node))) windows.push(node)
  }
  if (starts[nodeCount] !== edges.length) return { error: 'snapshot-schema-unsupported' }

  // Traverse native references only. Objects marked attached take precedence over
  // objects reachable solely from a detached native tree, as in DevTools.
  const queue = new Uint32Array(nodeCount)
  function propagate(state) {
    let end = 0
    for (let node = 0; node < nodeCount; node += 1) if (states[node] === state) queue[end++] = node
    for (let read = 0; read < end; read += 1) {
      const parent = queue[read]
      for (let edge = starts[parent]; edge < starts[parent + 1]; edge += edgeWidth) {
        const type = edges[edge + e.type]
        if (type === weak || type === hidden || type === invisible) continue
        const child = targetOf(edge)
        if (typeOf(child) !== nativeType || states[child] === state ||
            (state === DETACHED && states[child] === ATTACHED)) continue
        states[child] = state
        queue[end++] = child
      }
    }
  }
  propagate(ATTACHED)
  propagate(DETACHED)

  function walkStrong(seeds) {
    const parents = new Int32Array(nodeCount).fill(-1)
    const parentEdges = new Uint32Array(nodeCount)
    let end = 0
    for (const node of seeds) {
      parents[node] = node
      queue[end++] = node
    }
    for (let read = 0; read < end; read += 1) {
      const parent = queue[read]
      for (let edge = starts[parent]; edge < starts[parent + 1]; edge += edgeWidth) {
        const type = edges[edge + e.type]
        if (type === weak || type === invisible || (type === shortcut && parents[parent] !== parent)) continue
        const child = targetOf(edge)
        if (parents[child] !== -1) continue
        parents[child] = parent
        parentEdges[child] = edge
        queue[end++] = child
      }
    }
    return { parents, parentEdges }
  }
  const root = snapshot.root_index ? snapshot.root_index / nodeWidth : 0
  const rootPaths = walkStrong([root])
  const liveWindows = windows.filter(node => rootPaths.parents[node] !== -1).slice(0, 32)
  const windowPaths = walkStrong(liveWindows)

  const groups = new Map()
  for (let node = 0; node < nodeCount; node += 1) {
    if (typeOf(node) !== nativeType) continue
    const group = domGroup(nameOf(node)) || (states[node] === DETACHED ? 'Other native' : null)
    if (!group) continue
    if (!groups.has(group)) groups.set(group, { attached: 0, detached: 0, unknown: 0, selfBytes: 0, candidates: [] })
    const stats = groups.get(group)
    if (states[node] === ATTACHED) stats.attached += 1
    else if (states[node] === DETACHED) stats.detached += 1
    else stats.unknown += 1
    if (states[node] === DETACHED) stats.selfBytes += nodeSizes[node]
    if (states[node] === DETACHED || (group === 'Document' && states[node] !== ATTACHED)) stats.candidates.push(node)
  }

  const candidates = []
  const pathNodes = new Set()
  for (const [group, stats] of groups) {
    const count = Math.min(stats.candidates.length, PATHS_PER_GROUP)
    for (let i = 0; i < count; i += 1) {
      const node = stats.candidates[Math.floor(i * stats.candidates.length / count)]
      const path = windowPaths.parents[node] !== -1 ? windowPaths : rootPaths
      if (path.parents[node] === -1) continue
      const steps = []
      let current = node
      while (steps.length < MAX_PATH_STEPS) {
        pathNodes.add(current * nodeWidth)
        const parent = path.parents[current]
        steps.push({ current, edge: parent === current ? undefined : path.parentEdges[current] })
        if (parent === current) break
        current = parent
      }
      candidates.push({ group, scope: path === windowPaths ? 'window' : 'gc-root',
        truncated: path.parents[steps.at(-1).current] !== steps.at(-1).current, steps })
    }
  }

  const locations = new Map()
  const fields = meta.location_fields ?? []
  const [objectAt, scriptAt, lineAt, columnAt] = ['object_index', 'script_id', 'line', 'column']
    .map(field => fields.indexOf(field))
  if ([objectAt, scriptAt, lineAt, columnAt].every(index => index >= 0)) {
    const table = data.locations ?? []
    for (let i = 0; i < table.length; i += fields.length) {
      const nodeOffset = table[i + objectAt]
      const scriptId = table[i + scriptAt]
      if (pathNodes.has(nodeOffset) && Number.isInteger(scriptId) && scriptId > 0) {
        locations.set(nodeOffset, { scriptId: String(scriptId), line0: table[i + lineAt], column0: table[i + columnAt] })
      }
    }
  }

  function stepMetadata({ current, edge }) {
    const rawName = nameOf(current)
    const type = nodeTypes[typeOf(current)]
    const name = type === 'native' ? domGroup(rawName)
      : type === 'object' && isWindowName(rawName) ? 'Window'
      : SAFE_NAMES.has(rawName) ? rawName || undefined : undefined
    const edgeType = edge === undefined ? undefined : edgeTypes[edges[edge + e.type]]
    const edgeName = edge === undefined || edgeType === 'element' || edgeType === 'hidden'
      ? undefined : strings.get(edges[edge + e.name_or_index])
    return { type, name: name || undefined, edge: edgeType,
      property: SAFE_EDGES.has(edgeName) ? edgeName : undefined, location: locations.get(current * nodeWidth) }
  }

  const patterns = new Map()
  for (const { group, scope, truncated, steps } of candidates) {
    const leafFirst = steps.map(stepMetadata)
    const key = JSON.stringify([group, scope, truncated, leafFirst])
    if (!patterns.has(key)) patterns.set(key, { group, scope, truncated, leafFirst, samples: 0 })
    patterns.get(key).samples += 1
  }

  return {
    nodeCount, edgeCount, reachableWindows: liveWindows.length, sampledPaths: candidates.length,
    groups: Object.fromEntries([...groups].map(([group, { candidates: _, ...stats }]) => [group, stats])),
    paths: [...patterns.values()].sort((a, b) => b.samples - a.samples).slice(0, 16)
  }
}

const reader = new HeapSnapshotReader(safeSnapshotString)
let reportedLayout = false
parentPort.on('message', message => {
  try {
    if (message !== null) {
      reader.push(message.chunk)
      const layout = reportedLayout ? undefined : reader.layout
      if (layout) reportedLayout = true
      parentPort.postMessage({ consumedBytes: message.bytes, layout })
      return
    }
    parentPort.postMessage({ result: summarize(reader.finish()), layout: reader.layout })
  } catch (error) {
    parentPort.postMessage({ result: {
      error: error instanceof SnapshotReadError ? error.message : 'snapshot-parse-failed',
      diagnostic: error instanceof SnapshotReadError ? error.details : undefined
    }, layout: reader.layout })
  }
  parentPort.close()
})
