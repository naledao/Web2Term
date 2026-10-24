import type { JSX } from 'react'
import { FOCUS_COMPOSER_MODES } from '@shared/focus-chat'
import type { FocusComposerMode, FocusComposerModeId } from '@shared/focus-chat'

export default function FocusComposerModes({ modes, disabled, pending, onChange }: {
  modes: FocusComposerMode[]; disabled: boolean; pending: FocusComposerModeId | null
  onChange(id: FocusComposerModeId, active: boolean): void
}): JSX.Element {
  return <div className="focus-composer__modes" role="group" aria-label="DeepSeek 回答模式">
    {FOCUS_COMPOSER_MODES.map(({ id, label }) => {
      const mode = modes.find(item => item.id === id), active = mode?.active ?? null
      return <button key={id} type="button" className="focus-composer__mode" aria-pressed={active ?? undefined}
        aria-busy={pending === id} data-state={active === null ? 'unknown' : active ? 'on' : 'off'}
        disabled={disabled || pending !== null || active === null || mode?.disabled !== false}
        title={pending === id ? '正在同步原网页的开关状态' : active === null ? '尚未确认原网页的开关状态' : (active ? '关闭' : '开启') + label}
        onClick={() => { if (active !== null) onChange(id, !active) }}>
        {id === 'search' ?
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" />
          </svg> :
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
            <g transform="matrix(0.9907486438751221,0,0,0.9907486438751221,0.07401084899902344,0.07401084899902344)">
              <path fill="currentColor" stroke="none" d="M8,6.769999980926514 C8.678836822509766,6.769999980926514 9.229999542236328,7.321163177490234 9.229999542236328,8 C9.229999542236328,8.678836822509766 8.678836822509766,9.229999542236328 8,9.229999542236328 C7.321163177490234,9.229999542236328 6.769999980926514,8.678836822509766 6.769999980926514,8 C6.769999980926514,7.321163177490234 7.321163177490234,6.769999980926514 8,6.769999980926514z" />
            </g>
            <path d="M10.506570816040039,10.506570816040039 C7.301570892333984,13.711570739746094 3.5820748805999756,15.186075210571289 2.197999954223633,13.802000045776367 C0.81392502784729,12.417924880981445 2.289379835128784,8.698396682739258 5.494379997253418,5.493396282196045 C8.699379920959473,2.2883963584899902 12.417924880981445,0.81392502784729 13.802000045776367,2.197999954223633 C15.186075210571289,3.5820748805999756 13.711570739746094,7.301570892333984 10.506570816040039,10.506570816040039z" />
            <path d="M10.730999946594238,5.269000053405762 C13.935999870300293,8.473999977111816 15.3100004196167,12.293999671936035 13.802000045776367,13.802000045776367 C12.293999671936035,15.3100004196167 8.475000381469727,13.935999870300293 5.269999980926514,10.730999946594238 C2.065000057220459,7.526000022888184 0.6899999976158142,3.7060000896453857 2.197999954223633,2.197999954223633 C3.7060000896453857,0.6899999976158142 7.526000022888184,2.063999891281128 10.730999946594238,5.269000053405762z" />
          </svg>}
        {label}{pending === id ? <span className="focus-composer__mode-pending" aria-hidden="true">…</span> : null}
      </button>
    })}
  </div>
}
