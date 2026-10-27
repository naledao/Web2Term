import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { ComputerUsePreferences } from '@shared/computer-use'
import { MAX_COMPUTER_RESULT_DELAY_SECONDS, normalizeComputerResultDelay } from '@shared/computer-progress'
import './ComputerUseSettings.css'

interface Props {
  preferences: ComputerUsePreferences
  onChange(value: ComputerUsePreferences): void
  disabled: boolean
}

export default function ComputerUseSettings({ preferences, onChange, disabled }: Props): JSX.Element {
  const [delay, setDelay] = useState(String(preferences.computerResultDelaySeconds ?? 0))
  useEffect(() => { setDelay(String(preferences.computerResultDelaySeconds ?? 0)) }, [preferences.computerResultDelaySeconds])
  return <div className="computer-use-settings">
    <fieldset className="computer-use-settings__limits" disabled={disabled}>
      <legend>结果回传</legend>
      <div className="computer-use-settings__limit-grid">
        <label className="computer-use-settings__limit">
          <span>回传间隔</span>
          <span><input type="number" min={0} max={MAX_COMPUTER_RESULT_DELAY_SECONDS} step={1}
            value={delay} aria-label="computer 结果回传间隔（秒）" onChange={event => setDelay(event.currentTarget.value)}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            onBlur={() => {
              const seconds = normalizeComputerResultDelay(delay)
              setDelay(String(seconds))
              if (seconds !== (preferences.computerResultDelaySeconds ?? 0)) onChange({ ...preferences, computerResultDelaySeconds: seconds })
            }} /> 秒</span>
        </label>
      </div>
    </fieldset>
  </div>
}
