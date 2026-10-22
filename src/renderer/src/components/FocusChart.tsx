import type { JSX } from 'react'

/** A chart the page script read from a reply's accessible data list (see `chartData`). */
export interface FocusChartData {
  title: string
  caption: string
  series: Array<{ name: string; unit: string }>
  rows: Array<{ label: string; values: number[] }>
}

const COLORS = ['#4e6cdd', '#22a06b', '#e5813a', '#9b59b6', '#d14d72', '#1f9bb5']
const WIDTH = 640
const HEIGHT = 240
const PAD = { left: 44, right: 16, top: 14, bottom: 30 }

/** Accept only the shape the page script writes; anything else falls back to the quoted list. */
export function parseFocusChart(json: string): FocusChartData | null {
  try {
    const value = JSON.parse(json) as FocusChartData
    if (!value || typeof value.title !== 'string' || typeof value.caption !== 'string' || !Array.isArray(value.series) ||
      !Array.isArray(value.rows) || value.series.length < 1 || value.series.length > 6 || value.rows.length < 2 || value.rows.length > 200) return null
    if (value.series.some(item => !item || typeof item.name !== 'string' || typeof item.unit !== 'string')) return null
    if (value.rows.some(row => !row || typeof row.label !== 'string' || !Array.isArray(row.values) ||
      row.values.length !== value.series.length || row.values.some(item => !Number.isFinite(item)))) return null
    return value
  } catch { return null }
}

/** Round the axis to 0/1/2/2.5/5 × 10ⁿ steps so tick labels stay short. */
function niceStep(span: number): number {
  const raw = span / 4 || 1
  const power = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find(factor => factor * power >= raw) ?? 10) * power
}

/**
 * A plain line chart of a ChatGPT chart's data — the interactive original stays in the
 * original view. Hovering a point shows its value through the SVG title.
 */
export default function FocusChart({ data }: { data: FocusChartData }): JSX.Element {
  const all = data.rows.flatMap(row => row.values)
  const low = Math.min(0, ...all)
  const step = niceStep(Math.max(...all) - low)
  const min = Math.floor(low / step) * step
  const max = Math.max(min + step, Math.ceil(Math.max(...all) / step) * step)
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step)
  const plotWidth = WIDTH - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const x = (index: number): number => PAD.left + (data.rows.length === 1 ? plotWidth / 2 : index * plotWidth / (data.rows.length - 1))
  const y = (value: number): number => PAD.top + plotHeight - (value - min) / (max - min) * plotHeight
  const unit = data.series.every(item => item.unit === data.series[0].unit) ? data.series[0].unit : ''
  const format = (value: number): string => String(Math.round(value * 100) / 100)
  // Thin the x labels so they never overlap: about one per 56px.
  const every = Math.max(1, Math.ceil(data.rows.length / Math.floor(plotWidth / 56)))
  return <figure className="focus-chart">
    {/* No title of its own: the answer's heading above the card already names it. */}
    {data.title ? <figcaption className="focus-chart__title">{data.title}</figcaption> : null}
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={data.title || '图表'}>
      {ticks.map(tick => <g key={tick}>
        <line className="focus-chart__grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} />
        <text className="focus-chart__axis" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">{format(tick)}{unit}</text>
      </g>)}
      {data.rows.map((row, index) => index % every === 0 || index === data.rows.length - 1
        ? <text key={index} className="focus-chart__axis" x={x(index)} y={HEIGHT - 8} textAnchor="middle">{row.label}</text> : null)}
      {data.series.map((series, column) => <g key={column} style={{ color: COLORS[column % COLORS.length] }}>
        <polyline className="focus-chart__line" points={data.rows.map((row, index) => `${x(index)},${y(row.values[column])}`).join(' ')} />
        {data.rows.map((row, index) => <circle key={index} className="focus-chart__point" cx={x(index)} cy={y(row.values[column])} r={3.5}>
          <title>{`${row.label} · ${series.name}: ${format(row.values[column])}${series.unit}`}</title>
        </circle>)}
      </g>)}
    </svg>
    {data.series.length > 1 ? <div className="focus-chart__legend">{data.series.map((series, column) =>
      <span key={column}><i style={{ background: COLORS[column % COLORS.length] }} />{series.name}</span>)}</div> : null}
    {data.caption ? <p className="focus-chart__caption">{data.caption}</p> : null}
    <p className="focus-chart__hint">交互图表可在原始视图中查看</p>
  </figure>
}
