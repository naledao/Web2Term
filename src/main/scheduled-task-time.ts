import { CronExpressionParser } from 'cron-parser'
import type { TaskSchedule } from '../shared/scheduled-tasks'

export function nextScheduledTime(schedule: TaskSchedule, after: number): number {
  const next = schedule.kind === 'interval' ? after + schedule.minutes * 60_000
    : CronExpressionParser.parse(schedule.expression, { currentDate: new Date(after), tz: schedule.timeZone }).next().getTime()
  if (!Number.isSafeInteger(next) || next <= after || next > 8_640_000_000_000_000) throw new Error('周期无效或没有可计算的下次触发时间。')
  return next
}

/** Collapse missed occurrences while retaining the original fixed-rate anchor. */
export function dueScheduledTime(schedule: TaskSchedule, firstDue: number, now: number): { plannedAt: number; nextRunAt: number } {
  if (schedule.kind === 'interval') {
    const period = schedule.minutes * 60_000
    const plannedAt = firstDue + Math.floor(Math.max(0, now - firstDue) / period) * period
    return { plannedAt, nextRunAt: nextScheduledTime(schedule, plannedAt) }
  }
  const plannedAt = Math.max(firstDue, CronExpressionParser.parse(schedule.expression,
    { currentDate: new Date(now + 1), tz: schedule.timeZone }).prev().getTime())
  return { plannedAt, nextRunAt: nextScheduledTime(schedule, now) }
}
