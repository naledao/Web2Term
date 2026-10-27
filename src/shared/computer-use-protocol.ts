import type { ComputerUseActionDefinition, ComputerUseToolCall, ComputerUseWireRequest } from './computer-use'

export type ComputerUseProtocolErrorCode = 'invalid_json' | 'duplicate_field' | 'unsafe_field' | 'limit_exceeded'
  | 'invalid_envelope' | 'unsupported_version' | 'unknown_action' | 'invalid_parameters' | 'invalid_step_token'
  | 'stale_step_token' | 'ambiguous_request' | 'invalid_description'
export interface ComputerUseProtocolError { code: ComputerUseProtocolErrorCode; message: string; field: string; offset: number }
export type ComputerUseProtocolCheck =
  | { ok: true; request: ComputerUseWireRequest; call: ComputerUseToolCall; stepToken: string }
  | { ok: false; error: ComputerUseProtocolError; action: string; stepToken: string | null }

/** Self-contained application code: this same factory is injected into the page, without eval of model content. */
export function createComputerUseProtocol() {
  const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  const parametersMatch = (definition: ComputerUseActionDefinition, value: unknown): boolean => {
    if (!object(value) || Object.keys(value).some(key => !definition.parameters.some(parameter => parameter.name === key))) return false
    for (const parameter of definition.parameters) {
      if (!Object.hasOwn(value, parameter.name)) { if (parameter.required) return false; continue }
      const item = value[parameter.name]
      if (parameter.type === 'string' ? typeof item !== 'string'
        : parameter.type === 'boolean' ? typeof item !== 'boolean'
          : parameter.type === 'number' ? typeof item !== 'number' || !Number.isFinite(item)
            : parameter.type === 'integer' ? !Number.isSafeInteger(item)
              : parameter.type === 'array' ? !Array.isArray(item) : !object(item)) return false
      if (typeof item === 'number' && ((parameter.minimum !== undefined && item < parameter.minimum) ||
        (parameter.maximum !== undefined && item > parameter.maximum))) return false
      if (typeof item === 'string' && ((parameter.minLength !== undefined && item.length < parameter.minLength) ||
        (parameter.maxLength !== undefined && item.length > parameter.maxLength))) return false
      if (Array.isArray(item) && parameter.maxItems !== undefined && item.length > parameter.maxItems) return false
      if (parameter.enum && !parameter.enum.some(allowed => allowed === item)) return false
    }
    if (definition.locatorAlternatives) {
      const present = definition.locatorAlternatives.filter(group => group.some(key => Object.hasOwn(value, key)))
      if (present.length !== 1 || !present[0].every(key => Object.hasOwn(value, key))) return false
    }
    return true
  }

  /**
   * Which fields broke `parametersMatch`, plus the action's accepted parameters. A bare "parameters invalid"
   * left the model guessing: 2026-10-27 it sent scroll_direction/scroll_amount:778/window_id/target and was
   * told only that something was wrong.
   */
  const parameterIssues = (definition: ComputerUseActionDefinition, value: unknown): { field: string; message: string } => {
    const expected = (p: ComputerUseActionDefinition['parameters'][number]): string => p.enum ? p.enum.map(String).join('|')
      : [p.type, p.minimum !== undefined || p.maximum !== undefined ? `${p.minimum ?? ''}–${p.maximum ?? ''}` : '',
        p.maxLength !== undefined ? `≤${p.maxLength} 字` : '', p.maxItems !== undefined ? `≤${p.maxItems} 项` : ''].filter(Boolean).join(' ')
    const issues: string[] = [], fields: string[] = []
    if (!object(value)) issues.push('参数必须是 JSON 对象')
    else {
      const unknown = Object.keys(value).filter(key => !definition.parameters.some(p => p.name === key))
      if (unknown.length) { issues.push(`未知字段 ${unknown.slice(0, 8).join('、')}`); fields.push(...unknown) }
      const missing = definition.parameters.filter(p => p.required && !Object.hasOwn(value, p.name)).map(p => p.name)
      if (missing.length) { issues.push(`缺少必填 ${missing.join('、')}`); fields.push(...missing) }
      for (const p of definition.parameters) {
        if (!Object.hasOwn(value, p.name) || parametersMatch({ ...definition, parameters: [p], locatorAlternatives: undefined }, { [p.name]: value[p.name] })) continue
        issues.push(`${p.name} 应为 ${expected(p)}`); fields.push(p.name)
      }
      const groups = definition.locatorAlternatives
      if (groups) {
        const present = groups.filter(group => group.some(key => Object.hasOwn(value, key)))
        if (present.length !== 1 || !present[0].every(key => Object.hasOwn(value, key)))
          issues.push(`定位方式须且只能完整使用一组：${groups.map(group => group.join('+')).join(' 或 ')}`)
      }
    }
    const accepted = definition.parameters.map(p => `${p.name}${p.required ? '（必填）' : ''}`).join('、')
    return { field: fields[0] ?? '', message: (`${definition.action} 参数不符合定义：${issues.join('；') || '类型或范围不符'}。` +
      `可用参数：${accepted}。参数名必须完全一致，放在请求顶层。`).slice(0, 1200) }
  }

  const check = (raw: string, definitions: readonly ComputerUseActionDefinition[]): ComputerUseProtocolCheck => {
    let index = 0, nodes = 0, action = '', stepToken: string | null = null
    const fail = (code: ComputerUseProtocolErrorCode, message: string, field = '', offset = index): never => {
      throw { code, message, field: field.slice(0, 80), offset }
    }
    const space = (): void => { while (index < raw.length && /[\t\n\r ]/.test(raw[index])) index++ }
    const string = (): string => {
      const start = index++
      for (; index < raw.length; index++) {
        if (raw[index] === '\\') { index++; continue }
        if (raw.charCodeAt(index) < 32) fail('invalid_json', 'JSON 字符串包含未转义的控制字符。')
        if (raw[index] === '"') {
          const text = raw.slice(start, ++index)
          let decoded: string
          try { decoded = JSON.parse(text) as string } catch { return fail('invalid_json', 'JSON 字符串转义无效。', '', start) }
          if (decoded.length > 32_768) fail('limit_exceeded', '单个 JSON 字符串过长。', '', start)
          return decoded
        }
      }
      return fail('invalid_json', 'JSON 字符串尚未结束。', '', start)
    }
    const value = (depth: number): unknown => {
      space()
      if (depth > 16 || ++nodes > 2048) fail('limit_exceeded', 'JSON 嵌套或字段数量超出上限。')
      const ch = raw[index]
      if (ch === '"') return string()
      if (ch === '{') {
        index++; space()
        const result: Record<string, unknown> = Object.create(null)
        const keys = new Set<string>()
        if (raw[index] === '}') { index++; return result }
        while (index < raw.length) {
          if (raw[index] !== '"') fail('invalid_json', 'JSON 字段名必须使用双引号。')
          const start = index, key = string()
          if (keys.has(key)) fail('duplicate_field', '同一个 JSON 对象包含重复字段。', key, start)
          if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('unsafe_field', 'JSON 包含不允许的对象字段。', key, start)
          keys.add(key)
          if (keys.size > 128) fail('limit_exceeded', 'JSON 对象字段过多。')
          space()
          if (raw[index++] !== ':') fail('invalid_json', 'JSON 字段缺少冒号。')
          result[key] = value(depth + 1)
          space()
          if (raw[index] === '}') { index++; return result }
          if (raw[index++] !== ',') fail('invalid_json', 'JSON 字段之间缺少逗号。')
          space()
        }
        return fail('invalid_json', 'JSON 对象尚未结束。')
      }
      if (ch === '[') {
        index++; space()
        const result: unknown[] = []
        if (raw[index] === ']') { index++; return result }
        while (index < raw.length) {
          if (result.length >= 256) fail('limit_exceeded', 'JSON 数组元素过多。')
          result.push(value(depth + 1)); space()
          if (raw[index] === ']') { index++; return result }
          if (raw[index++] !== ',') fail('invalid_json', 'JSON 数组元素之间缺少逗号。')
          space()
        }
        return fail('invalid_json', 'JSON 数组尚未结束。')
      }
      for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const) {
        if (raw.startsWith(literal, index)) { index += literal.length; return result }
      }
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(index))
      if (!number) return fail('invalid_json', 'JSON 值或数字格式无效。')
      index += number[0].length
      const result = Number(number[0])
      if (!Number.isFinite(result) || (Number.isInteger(result) && !Number.isSafeInteger(result))) fail('invalid_parameters', '数字超出可准确处理的范围。')
      return result
    }
    try {
      if (typeof raw !== 'string' || !raw.trim()) fail('invalid_json', 'computer 请求必须是一个完整 JSON 对象。')
      if (raw.length > 64_000) fail('limit_exceeded', 'computer 请求长度超出上限。')
      const parsed = value(0)
      space()
      if (index !== raw.length) fail('ambiguous_request', '本轮只能有一个 computer JSON 请求，不得附加其他请求或正文。')
      if (!object(parsed) || parsed.type !== 'computer') fail('invalid_envelope', 'type 必须为 computer，且请求必须为对象。')
      const request = parsed as Record<string, unknown>
      action = typeof request.action === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(request.action) ? request.action : ''
      stepToken = typeof request.step_token === 'string' ? request.step_token : null
      if (request.version !== 1) fail('unsupported_version', 'computer 协议 version 必须为数字 1。', 'version')
      if (!action) fail('unknown_action', 'action 必须是当前注册的桌面动作名称。', 'action')
      if (!stepToken || !/^cu_[a-f0-9]{32}$/.test(stepToken)) fail('invalid_step_token', 'step_token 必须使用软件提供的当前有效令牌。', 'step_token')
      if (['command', 'read_files', 'questions', 'question', 'files', 'background'].some(key => Object.hasOwn(request, key))) {
        fail('ambiguous_request', 'computer 请求不得混入终端、文件或提问请求。')
      }
      const definition = definitions.find(item => item.action === action)
      if (!definition) fail('unknown_action', '当前没有注册这个 computer 动作。', 'action')
      const description = request.description
      if (typeof description !== 'string' || !description.trim() || description.length > 160 ||
        /[\x00-\x1f\x7f\u2028\u2029]/.test(description) || !/[\u3400-\u9fff]/.test(description))
        fail('invalid_description', 'description 必须是 1–160 字的单行中文动作描述，说明本步准备做什么；仅用于展示，不代表执行成功。', 'description')
      const parameters = Object.fromEntries(Object.entries(request).filter(([key]) => !['type', 'version', 'action', 'step_token', 'description'].includes(key)))
      if (!parametersMatch(definition!, parameters)) {
        const issue = parameterIssues(definition!, parameters)
        fail('invalid_parameters', issue.message, issue.field)
      }
      return { ok: true, request: request as ComputerUseWireRequest, call: { action, parameters, description: (description as string).trim() }, stepToken: stepToken! }
    } catch (error) {
      const issue = error as ComputerUseProtocolError
      return { ok: false, action, stepToken, error: issue && typeof issue.code === 'string' ? issue
        : { code: 'invalid_json', message: 'computer 请求解析失败，本次未执行。', field: '', offset: index } }
    }
  }
  return { check, parametersMatch, parameterIssues }
}

export const computerUseProtocol = createComputerUseProtocol()
