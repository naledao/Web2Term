import { useCallback, useEffect, useRef, useState } from 'react'
import type { AdminDailyCount, AdminStats } from '../../../../shared/admin'

export type AdminJump =
  | { section: 'feedback'; status?: number | null }
  | { section: 'release-notes'; status?: number | null }
  | { section: 'users'; enabled?: boolean | null }
  | { section: 'machines' }

const time = (value: number): string => new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
const percent = (part: number, total: number): string => total ? `${Math.round((part / total) * 1000) / 10}%` : '—'

interface Tile { label: string; value: number; hint?: string; jump?: AdminJump; tone?: 'attention' }

function TileGroup({ title, tiles, onJump }: { title: string; tiles: Tile[]; onJump(jump: AdminJump): void }) {
  return <section className="admin-overview__group" aria-label={title}>
    <h2>{title}</h2>
    <div className="admin-overview__tiles">{tiles.map(tile => {
      const body = <><span className="admin-tile__label">{tile.label}</span><strong className="admin-tile__value">{tile.value.toLocaleString('zh-CN')}</strong>
        {tile.hint ? <span className="admin-tile__hint">{tile.hint}</span> : null}</>
      return tile.jump
        ? <button key={tile.label} type="button" className={`admin-tile is-link${tile.tone === 'attention' && tile.value > 0 ? ' is-attention' : ''}`} onClick={() => onJump(tile.jump!)}>{body}</button>
        : <div key={tile.label} className="admin-tile">{body}</div>
    })}</div>
  </section>
}

/** Single-series daily bar chart: thin bars, 2px gaps, rounded data ends, hover tooltip and a data table. */
function DailyBars({ data }: { data: AdminDailyCount[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const width = 720, height = 180, left = 32, right = 8, top = 12, bottom = 26
  const plotWidth = width - left - right, plotHeight = height - top - bottom
  const max = Math.max(1, ...data.map(item => item.count))
  const step = Math.max(1, Math.ceil(max / 3))
  const ticks = [0, step, step * 2, step * 3].filter(value => value <= Math.max(max, step))
  const scaleMax = ticks[ticks.length - 1] || 1
  const slot = plotWidth / Math.max(1, data.length)
  const barWidth = Math.max(2, slot - 2)
  const y = (value: number): number => top + plotHeight - (value / scaleMax) * plotHeight
  const bar = (index: number, value: number): string => {
    const x = left + index * slot + (slot - barWidth) / 2
    const h = Math.max(0, (value / scaleMax) * plotHeight)
    if (h <= 0) return ''
    const r = Math.min(4, barWidth / 2, h)
    const base = top + plotHeight
    return `M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + barWidth - r}Q${x + barWidth},${base - h} ${x + barWidth},${base - h + r}V${base}Z`
  }
  const active = hover !== null ? data[hover] : null
  return <figure className="admin-chart">
    <div className="admin-chart__plot">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`近 ${data.length} 天每日新增机器数`} onMouseLeave={() => setHover(null)}>
        {ticks.map(value => <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} className={value === 0 ? 'admin-chart__baseline' : 'admin-chart__grid'} />
          <text x={left - 6} y={y(value)} dy="0.32em" textAnchor="end" className="admin-chart__tick">{value}</text>
        </g>)}
        {data.map((item, index) => <path key={item.date} d={bar(index, item.count)} className={`admin-chart__bar${hover === index ? ' is-active' : ''}`} />)}
        {data.map((item, index) => index % 7 === data.length % 7 || index === data.length - 1
          ? <text key={`label-${item.date}`} x={left + index * slot + slot / 2} y={height - 8} textAnchor="middle" className="admin-chart__tick">{item.date.slice(5)}</text> : null)}
        {data.map((item, index) => <rect key={`hit-${item.date}`} x={left + index * slot} y={top} width={slot} height={plotHeight}
          fill="transparent" onMouseEnter={() => setHover(index)} tabIndex={0} onFocus={() => setHover(index)} onBlur={() => setHover(null)}
          aria-label={`${item.date}：新增 ${item.count} 台`} />)}
      </svg>
      {active && hover !== null ? <div className="admin-chart__tooltip" role="status"
        style={{ left: `${((left + hover * slot + slot / 2) / width) * 100}%` }}>
        <span>{active.date}</span><strong>{active.count} 台</strong>
      </div> : null}
    </div>
    <details className="admin-chart__table">
      <summary>查看数据表</summary>
      <table><thead><tr><th>日期</th><th>新增机器</th></tr></thead>
        <tbody>{data.map(item => <tr key={item.date}><td>{item.date}</td><td>{item.count}</td></tr>)}</tbody></table>
    </details>
  </figure>
}

export default function AdminOverview({ active, onJump }: { active: boolean; onJump(jump: AdminJump): void }) {
  const alive = useRef(true)
  const request = useRef(0)
  const [stats, setStats] = useState<AdminStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [blocked, setBlocked] = useState('')
  const [loadedAt, setLoadedAt] = useState(0)

  const load = useCallback(async (): Promise<void> => {
    const revision = ++request.current
    setLoading(true); setError('')
    try {
      const result = await window.api.getAdminStats()
      if (!alive.current || revision !== request.current) return
      if (!result.ok) {
        if (result.loginRequired || result.forbidden) setBlocked(result.message)
        else setError(result.message)
        return
      }
      setBlocked(''); setStats(result.value); setLoadedAt(Date.now())
    } catch { if (alive.current && revision === request.current) setError('读取统计失败，请重试。') }
    finally { if (alive.current && revision === request.current) setLoading(false) }
  }, [])

  useEffect(() => () => { alive.current = false }, [])
  // Refresh whenever the overview is shown again, at most once every 30 seconds.
  useEffect(() => { if (active && Date.now() - loadedAt > 30_000) void load() }, [active, load, loadedAt])

  if (blocked) {
    return <section className="admin-page admin-page--blocked" role="alert">
      <h1>无法读取概览</h1><p>{blocked}</p>
      <button type="button" className="admin-btn" onClick={() => { setBlocked(''); void load() }}>重试</button>
    </section>
  }

  return <section className="admin-page admin-overview">
    <header className="admin-page__header">
      <div><h1>概览</h1><p className="admin-muted">{loadedAt ? `更新于 ${new Date(loadedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '后端运行情况一览'}</p></div>
      <button type="button" className="admin-btn" disabled={loading} onClick={() => void load()}>{loading ? '加载中…' : '刷新'}</button>
    </header>
    {error ? <div className="admin-error" role="alert">{error}<button type="button" className="admin-btn admin-btn--small" onClick={() => void load()}>重试</button></div> : null}
    {!stats ? (!error ? <p className="admin-empty" role="status">正在加载…</p> : null) : <div className="admin-overview__scroll">
      <TileGroup title="反馈" onJump={onJump} tiles={[
        { label: '待处理', value: stats.feedback.pending, jump: { section: 'feedback', status: 0 }, tone: 'attention' },
        { label: '处理中', value: stats.feedback.inProgress, jump: { section: 'feedback', status: 1 } },
        { label: '近 7 天新增', value: stats.feedback.new7d, jump: { section: 'feedback', status: null } },
        { label: '累计', value: stats.feedback.total, jump: { section: 'feedback', status: null } }
      ]} />
      <TileGroup title="用户" onJump={onJump} tiles={[
        { label: '用户总数', value: stats.users.total, jump: { section: 'users', enabled: null } },
        { label: '近 7 天新增', value: stats.users.new7d },
        { label: '近 7 天登录', value: stats.users.active7d, hint: '按最后登录时间统计' },
        { label: '已禁用', value: stats.users.disabled, jump: { section: 'users', enabled: false } },
        { label: '在线设备', value: stats.onlineDevices, hint: '当前连接到后端的设备' }
      ]} />
      <TileGroup title="更新说明" onJump={onJump} tiles={[
        { label: '已发布', value: stats.releaseNotes.published, jump: { section: 'release-notes', status: 1 } },
        { label: '预约中', value: stats.releaseNotes.scheduled, jump: { section: 'release-notes', status: 1 } },
        { label: '草稿', value: stats.releaseNotes.drafts, jump: { section: 'release-notes', status: 0 } },
        { label: '已下线', value: stats.releaseNotes.offline, jump: { section: 'release-notes', status: 2 } }
      ]} />
      <TileGroup title="机器（看过更新说明的客户端）" onJump={onJump} tiles={[
        { label: '机器总数', value: stats.machines.total, jump: { section: 'machines' } },
        { label: '近 7 天看过', value: stats.machines.read7d, jump: { section: 'machines' } },
        { label: '近 30 天看过', value: stats.machines.read30d, jump: { section: 'machines' } }
      ]} />
      <section className="admin-overview__group">
        <h2>近 30 天每日新增机器</h2>
        <p className="admin-muted admin-overview__note">按每台机器第一次阅读更新说明的日期（北京时间）统计。</p>
        <DailyBars data={stats.machines.dailyNew} />
      </section>
      <section className="admin-overview__group">
        <h2>最近更新说明的阅读覆盖</h2>
        {stats.machines.noteReach.length ? <table className="admin-reach">
          <thead><tr><th>版本</th><th>标题</th><th>发布日期</th><th>已读机器</th><th className="admin-reach__bar-head">覆盖率</th></tr></thead>
          <tbody>{stats.machines.noteReach.map(item => <tr key={item.id}>
            <td>v{item.version}</td><td className="admin-reach__title">{item.title}</td><td>{time(item.publishedAt)}</td>
            <td>{item.readCount.toLocaleString('zh-CN')}</td>
            <td><span className="admin-reach__bar"><span style={{ width: `${stats.machines.total ? Math.min(100, (item.readCount / stats.machines.total) * 100) : 0}%` }} /></span>
              <span className="admin-reach__pct">{percent(item.readCount, stats.machines.total)}</span></td>
          </tr>)}</tbody>
        </table> : <p className="admin-empty">还没有已发布的更新说明</p>}
      </section>
    </div>}
  </section>
}
