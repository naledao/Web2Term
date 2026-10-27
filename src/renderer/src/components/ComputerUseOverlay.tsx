import type { ComputerOverlaySnapshot } from '@shared/computer-overlay'
import './ComputerUseOverlay.css'

export default function ComputerUseOverlay({ snapshot, error }: { snapshot: ComputerOverlaySnapshot | null; error?: string }) {
  const state = snapshot?.tone ?? 'idle'

  return (
    <section className="computer-use-overlay" data-state={state} data-completed={snapshot?.completed || undefined} aria-label="Computer Use 任务展示">
      <header className="computer-use-overlay__notice" role="status" aria-live="polite">
        <span className="computer-use-overlay__notice-dot" aria-hidden="true" />
        <strong>{snapshot?.completed ? 'Computer Use 任务已完成' : 'Web2Term 正在操控您的电脑'}</strong>
        <span className="computer-use-overlay__notice-status">{error ? '进度暂不可用' : snapshot?.status ?? '等待任务'}</span>
        <span className="computer-use-overlay__escape-hint">{snapshot?.completed ? '提示将自动收起' : '连续双击 ESC 退出 Computer Use'}</span>
      </header>
      {snapshot ? <div className="computer-use-overlay__content">
        <section className="computer-use-overlay__lane computer-use-overlay__lane--goal">
          <div className="computer-use-overlay__label">任务目标</div>
          <div className="computer-use-overlay__goal-text">{snapshot.goal}</div>
        </section>
        <section className="computer-use-overlay__lane computer-use-overlay__lane--action">
          <div className="computer-use-overlay__label">{snapshot.completed ? '任务结果' : '当前动作'} <span>{error ? '进度暂不可用' : snapshot.actionStatus}</span></div>
          <div className="computer-use-overlay__action-text">{snapshot.completed ? snapshot.result : snapshot.action}</div>
          <div className="computer-use-overlay__current-detail">{snapshot.completed ? '自动操作已结束，可返回对话查看结果' : <>第 {snapshot.steps} 步</>}</div>
        </section>
      </div> : <div className="computer-use-overlay__empty">{error || '收到 computer use 任务后，在这里展示模型的中文动作描述与实际执行进度。'}</div>}

      {snapshot?.status === '等待你的回答' ? <div className="computer-use-overlay__waiting">需要你补充信息</div> : null}
    </section>
  )
}
