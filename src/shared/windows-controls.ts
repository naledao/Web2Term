export const UIA_ROLES = ['button', 'calendar', 'check_box', 'combo_box', 'edit', 'hyperlink', 'image', 'list_item', 'list', 'menu', 'menu_bar', 'menu_item', 'progress_bar', 'radio_button', 'scroll_bar', 'slider', 'spinner', 'status_bar', 'tab', 'tab_item', 'text', 'tool_bar', 'tool_tip', 'tree', 'tree_item', 'custom', 'group', 'thumb', 'data_grid', 'data_item', 'document', 'split_button', 'window', 'pane', 'header', 'header_item', 'table', 'title_bar', 'separator', 'semantic_zoom', 'app_bar'] as const
export const UIA_PATTERNS = ['invoke', 'selection', 'value', 'range_value', 'scroll', 'expand_collapse', 'grid', 'grid_item', 'multiple_view', 'selection_item', 'table', 'table_item', 'text', 'toggle', 'transform', 'window', 'scroll_item', 'legacy_accessible'] as const
export const CONTROL_LIMITATIONS = ['node_limit', 'depth_limit', 'time_limit', 'provider_error', 'properties_unavailable', 'cycle_detected', 'focus_changed', 'selection_truncated', 'result_budget', 'name_truncated'] as const
export interface ControlBounds { x: number; y: number; width: number; height: number }
export interface DesktopControl {
  element_id: string
  parent_id: string | null
  depth: number
  control_type: number | null
  role: string
  name: string | null
  name_truncated: boolean
  password: boolean | null
  enabled: boolean | null
  focused: boolean | null
  offscreen: boolean | null
  selected: boolean | null
  bounds: ControlBounds | null
  patterns: string[]
  properties_complete: boolean
}
export interface ControlTreeObservation {
  binding?: import('./windows-observation-binding').ObservationBinding
  observation_id: string
  window_id: string
  window_identity: { hwnd: string; pid: number; process_started_at: string; thread_id: number; class_name: string }
  before_at: string
  observed_at: string
  window_bounds: ControlBounds
  root_element_id: string | null
  elements: DesktopControl[]
  focus: { status: 'inside_target' | 'outside_target' | 'unavailable' | 'changed'; element_id: string | null }
  selection: { requested: boolean; status: 'not_requested' | 'text' | 'empty' | 'unsupported' | 'protected' | 'unavailable' | 'focus_outside' | 'not_in_tree' | 'changed'; element_id: string | null; text: string | null; truncated: boolean }
  complete: boolean
  limitations: string[]
  visited_count: number
  geometry_consistent: true
  snapshot_atomic: false
  content_verified: false
  input_ready: false
  goal_verified: false
}
