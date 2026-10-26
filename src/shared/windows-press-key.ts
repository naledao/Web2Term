import type { ComputerUseActionDefinition } from './computer-use'

export interface PressKeySpec { name: string; vk: number; extended: boolean }
export interface PressKeyChord { key: string; down: PressKeySpec[] }
const spec = (name: string, vk: number, extended = false): PressKeySpec => ({ name, vk, extended })
const modifiers = [spec('Control', 0xa2), spec('Alt', 0xa4), spec('Shift', 0xa0), spec('Win', 0x5b, true)]
const named = [spec('Backspace', 8), spec('Tab', 9), spec('Enter', 13), spec('Escape', 27), spec('Space', 32), spec('CapsLock', 20),
  ...['PageUp', 'PageDown', 'End', 'Home', 'Left', 'Up', 'Right', 'Down'].map((name, i) => spec(name, 33 + i, true)),
  spec('Insert', 45, true), spec('Delete', 46, true), spec('Menu', 93, true), spec('NumpadEnter', 13, true),
  spec('Multiply', 106), spec('Add', 107), spec('Subtract', 109), spec('Decimal', 110), spec('Divide', 111, true),
  ...Array.from({ length: 10 }, (_, i) => spec('Numpad' + i, 96 + i)),
  ...Array.from({ length: 26 }, (_, i) => spec(String.fromCharCode(65 + i), 65 + i)),
  ...Array.from({ length: 10 }, (_, i) => spec(String(i), 48 + i)),
  ...Array.from({ length: 24 }, (_, i) => spec('F' + (i + 1), 112 + i))]
const aliases: Record<string, string> = { ctrl: 'control', ctl: 'control', option: 'alt', windows: 'win', meta: 'win',
  esc: 'escape', return: 'enter', spacebar: 'space', pgup: 'pageup', pgdn: 'pagedown', del: 'delete', ins: 'insert',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', apps: 'menu' }
export function parsePressKey(value: unknown): PressKeyChord | null {
  if (typeof value !== 'string' || !value.trim() || value.length > 80 || /[^a-zA-Z0-9+ ]/.test(value)) return null
  const tokens = value.split('+').map(s => s.trim().toLowerCase()).map(s => Object.hasOwn(aliases, s) ? aliases[s] : s)
  if (tokens.length > 5 || tokens.some(s => !s) || new Set(tokens).size !== tokens.length) return null
  const primaryName = tokens.at(-1)!, primary = [...named, ...modifiers].find(s => s.name.toLowerCase() === primaryName)
  if (!primary || tokens.length > 1 && modifiers.some(s => s.name === primary.name) ||
    tokens.slice(0, -1).some(s => !modifiers.some(m => m.name.toLowerCase() === s))) return null
  const down = [...modifiers.filter(s => tokens.slice(0, -1).includes(s.name.toLowerCase())), primary]
  if (primary.name === 'Delete' && down.some(s => s.name === 'Control') && down.some(s => s.name === 'Alt')) return null // SendInput cannot synthesize the secure attention sequence.
  return { key: down.map(s => s.name).join('+'), down: down.map(s => ({ ...s })) }
}
/** Keys left down by the accepted prefix, or every attempted key when the acknowledgement is unknown. */
export function pressKeyReleaseNames(chord: PressKeyChord, accepted: number | null): string[] {
  if (accepted === null) return chord.down.map(s => s.name).reverse()
  const held: string[] = []
  const sequence = [...chord.down.map(s => ({ name: s.name, up: false })), ...[...chord.down].reverse().map(s => ({ name: s.name, up: true }))]
  for (const event of sequence.slice(0, accepted)) { if (event.up) held.splice(held.indexOf(event.name), 1); else held.push(event.name) }
  return held.reverse()
}
export const PRESS_KEY_DEFINITION: ComputerUseActionDefinition = {
  action: 'press_key',
  description: '在最近观察的前台业务窗口中按一次键或组合键，例如 Tab、Escape、Control+S、Control+Shift+S、Alt+F4。key 是按键名称，不是文字：字母大小写不隐含 Shift，正文用 type_text。支持导航／编辑键、A-Z、0-9、F1-F24、命名数字小键盘及 Control/Alt/Shift/Win；修饰键也可单独按一次。每次只派发一个完整组合，不提供跨轮按住、任意 VK/扫描码、脚本、重复次数或延时。必须绑定最新窗口观察；element_id 可选，指定时须为本组实际焦点控件，未指定时核对窗口的 Win32 焦点路由，可用于 UIA 不可读时的键盘导航。需要窗口已前台且无菜单／捕获／移动占用，不操作本软件控制窗口，不绕过 UAC 或安全桌面；Control+Alt+Delete 不受支持。仅在目标键和修饰键当前未按下时派发；记录实际接收数，异常／取消只尝试释放本次可能按下的键，不补按、不重放。操作后返回新观察或明确观察失败，完整事件接收不等于保存、确认或业务成功。',
  parameters: [
    { name: 'observation_id', type: 'string', required: true, minLength: 36, maxLength: 36, description: '本任务最近一组业务窗口观察；显示器概览不能直接授权按键。' },
    { name: 'element_id', type: 'string', required: false, minLength: 35, maxLength: 35, description: '可选，本组实际获得焦点的控件；省略时针对已核对焦点路由的窗口。' },
    { name: 'key', type: 'string', required: true, minLength: 1, maxLength: 80, description: '一个按键或组合：Tab、Enter、Escape、Space、Backspace、Delete、Insert、Home/End、PageUp/PageDown、方向键、Control+Shift+S 等；Ctrl/Esc/Return 等别名会规范化。' }
  ],
  example: { observation_id: 'obs_' + '0'.repeat(32), key: 'Control+S' }
}
export function validatePressKeyParameters(p: Record<string, unknown>): string | null {
  const id = (v: unknown, prefix: string): boolean => typeof v === 'string' && new RegExp('^' + prefix + '[a-f0-9]{32}$').test(v)
  return !id(p.observation_id, 'obs_') || p.element_id !== undefined && !id(p.element_id, 'el_') || !parsePressKey(p.key) ||
    Object.keys(p).some(k => !['observation_id', 'element_id', 'key'].includes(k))
    ? 'press_key 只接受最新窗口观察、可选焦点控件及一个受支持的按键／组合；不接受原生代码、脚本、按住或重复指令。' : null
}
export interface WindowsPressKeyReceipt {
  request_id: string; observation_id: string; source_step_id: string; window_id: string | null; element_id: string | null
  key: string; input_attempted: boolean; input_completed: boolean; events_requested: number; events_accepted: number | null
  release_keys: string[]; release_accepted: number | null; before_at: string; completed_at: string; goal_verified: false; input_ready: false
}
