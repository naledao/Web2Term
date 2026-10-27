import type { JSX } from 'react'

/** A chart the page script read from a reply's accessible data list (see `chartData`). */
export interface FocusChartData {
  kind: 'bar' | 'line' | 'table'
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
      !Array.isArray(value.rows) || value.series.length < 1 || value.series.length > 6 || value.rows.length < 1 || value.rows.length > 200) return null
    if (value.kind !== undefined && !['bar', 'line', 'table'].includes(value.kind)) return null
    if (value.series.some(item => !item || typeof item.name !== 'string' || typeof item.unit !== 'string')) return null
    if (value.rows.some(row => !row || typeof row.label !== 'string' || !Array.isArray(row.values) ||
      row.values.length !== value.series.length || row.values.some(item => !Number.isFinite(item)))) return null
    // Older saved markers did not record a type; their data cannot establish one.
    return { ...value, kind: value.kind ?? 'table' }
  } catch { return null }
}

/** Round the axis to 0/1/2/2.5/5 × 10ⁿ steps so tick labels stay short. */
function niceStep(span: number): number {
  const raw = span / 4 || 1
  const power = 10 ** Math.floor(Math.log10(raw))
  return ([1, 2, 2.5, 5, 10].find(factor => factor * power >= raw) ?? 10) * power
}

/**
 * Preserve the native chart kind. Unsupported or legacy charts keep their full data
 * in a table instead of being silently converted into a line chart.
 */
export default function FocusChart({ data }: { data: FocusChartData }): JSX.Element {
  const all = data.rows.flatMap(row => row.values)
  const low = Math.min(0, ...all)
  const high = Math.max(0, ...all)
  const step = niceStep(high - low)
  const min = Math.floor(low / step) * step
  const max = Math.max(min + step, Math.ceil(high / step) * step)
  const table = <div className="focus-chart__table"><table>
    <thead><tr><th scope="col">类别</th>{data.series.map((series, index) => <th key={index} scope="col">{series.name}{series.unit ? ` (${series.unit})` : ''}</th>)}</tr></thead>
    <tbody>{data.rows.map((row, index) => <tr key={index}><th scope="row">{row.label}</th>{row.values.map((value, column) => <td key={column}>{String(value)}{data.series[column].unit}</td>)}</tr>)}</tbody>
  </table></div>
  if (data.kind === 'table' || !Number.isFinite(max - min) || !(max > min)) return <figure className="focus-chart">
    {data.title ? <figcaption className="focus-chart__title">{data.title}</figcaption> : null}
    {data.caption ? <p className="focus-chart__caption">{data.caption}</p> : null}
    {table}
    <p className="focus-chart__hint">原图类型暂未识别或暂不支持，已保留完整数据；可在原始视图中查看图表。</p>
  </figure>
  const ticks = Array.from({ length: Math.round((max - min) / step) + 1 }, (_, index) => min + index * step)
  // Category labels have their own band (also at the ends); long labels wrap below.
  const width = Math.max(WIDTH, data.rows.length * (data.kind === 'bar' ? 96 : 0) + PAD.left + PAD.right)
  const plotWidth = width - PAD.left - PAD.right
  const plotHeight = HEIGHT - PAD.top - PAD.bottom
  const band = plotWidth / data.rows.length
  const x = (index: number): number => PAD.left + (index + .5) * band
  const y = (value: number): number => PAD.top + plotHeight - (value - min) / (max - min) * plotHeight
  const unit = data.series.every(item => item.unit === data.series[0].unit) ? data.series[0].unit : ''
  const format = (value: number): string => String(Number(value.toPrecision(6)))
  // Thin the x labels so they never overlap: about one per 56px.
  const every = Math.max(1, Math.ceil(data.rows.length / Math.floor(plotWidth / 56)))
  const labelSize = Math.max(4, Math.floor(band * every / 11))
  const labels = data.rows.map(row => {
    const chars = Array.from(row.label)
    return Array.from({ length: Math.min(3, Math.ceil(chars.length / labelSize)) }, (_, index) =>
      chars.slice(index * labelSize, (index + 1) * labelSize).join('') + (index === 2 && chars.length > labelSize * 3 ? '…' : ''))
  })
  const height = HEIGHT + (Math.max(...labels.map(lines => lines.length)) - 1) * 14
  return <figure className="focus-chart">
    {data.title ? <figcaption className="focus-chart__title">{data.title}</figcaption> : null}
    {data.caption ? <p className="focus-chart__caption">{data.caption}</p> : null}
    <div className="focus-chart__plot"><svg style={{ minWidth: width > WIDTH ? width : undefined }} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={data.title || (data.kind === 'bar' ? '柱状图' : '折线图')}>
      {ticks.map(tick => <g key={tick}>
        <line className="focus-chart__grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
        <text className="focus-chart__axis" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">{format(tick)}{unit}</text>
      </g>)}
      {data.rows.map((row, index) => index % every === 0 || index === data.rows.length - 1
        ? <text key={index} className="focus-chart__axis" x={x(index)} y={HEIGHT - 8} textAnchor="middle"><title>{row.label}</title>
          {labels[index].map((line, lineIndex) => <tspan key={lineIndex} x={x(index)} dy={lineIndex ? 14 : 0}>{line}</tspan>)}</text> : null)}
      {data.series.map((series, column) => <g key={column} style={{ color: COLORS[column % COLORS.length] }}>
        {data.kind === 'line' ? <polyline className="focus-chart__line" points={data.rows.map((row, index) => `${x(index)},${y(row.values[column])}`).join(' ')} /> : null}
        {data.rows.map((row, index) => {
          const title = <title>{`${row.label} · ${series.name}: ${row.values[column]}${series.unit}`}</title>
          const barWidth = band * .68 / data.series.length
          return data.kind === 'bar' ? <rect key={index} className="focus-chart__bar"
            x={x(index) - band * .34 + column * barWidth} y={Math.min(y(0), y(row.values[column]))}
            width={barWidth} height={Math.abs(y(row.values[column]) - y(0))} rx={3}>{title}</rect>
            : <circle key={index} className="focus-chart__point" cx={x(index)} cy={y(row.values[column])} r={3.5}>{title}</circle>
        })}
      </g>)}
    </svg></div>
    {data.series.length > 1 ? <div className="focus-chart__legend">{data.series.map((series, column) =>
      <span key={column}><i style={{ background: COLORS[column % COLORS.length] }} />{series.name}</span>)}</div> : null}
    <details className="focus-chart__data"><summary>查看数据</summary>{table}</details>
    <p className="focus-chart__hint">交互图表可在原始视图中查看</p>
  </figure>
}
