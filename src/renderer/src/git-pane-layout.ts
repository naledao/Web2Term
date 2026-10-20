export const GIT_PANE_MIN_WIDTH = 260
export const GIT_DIFF_MIN_WIDTH = 420
export const GIT_DIVIDER_WIDTH = 8

/** Keep both panes inside their container, including small windows and display zoom. */
export function gitPaneBounds(containerWidth: number): { min: number; max: number } {
  const available = Math.max(0, Number.isFinite(containerWidth) ? containerWidth - GIT_DIVIDER_WIDTH : 0)
  const min = Math.min(GIT_PANE_MIN_WIDTH, available / 2)
  return { min, max: Math.max(min, available - GIT_DIFF_MIN_WIDTH) }
}

export function clampGitPaneWidth(width: number, containerWidth: number): number {
  const { min, max } = gitPaneBounds(containerWidth)
  return Math.min(max, Math.max(min, Number.isFinite(width) ? width : 360))
}
