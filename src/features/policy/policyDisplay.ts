export interface PolicyDisplayRow {
  readonly label: string
  readonly value: string
}

export interface PolicyDisplaySection {
  readonly title: string
  readonly rows: readonly PolicyDisplayRow[]
}

export type PolicyRulesDisplay =
  | { readonly kind: 'table'; readonly sections: readonly PolicyDisplaySection[] }
  | { readonly kind: 'raw' }

const numericSource = Symbol('policy number source')
const missing = Symbol('missing policy field')
const raw = Object.freeze({ kind: 'raw' } as const)
type ExactNumber = { readonly [numericSource]: string }
type Fields = Record<string, unknown>

function unavailable(): never { throw new Error('Policy table unavailable') }

function object(value: unknown): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.hasOwn(value, numericSource)) unavailable()
  return value as Fields
}

function own(value: Fields, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : missing
}

function numberToken(value: unknown): value is ExactNumber {
  return value !== null && typeof value === 'object' && Object.hasOwn(value, numericSource)
}

function scalar(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // Only strings are quoted for legible whitespace/escapes; JSON numbers are never reserialized.
  if (typeof value === 'string') return JSON.stringify(value)
  if (numberToken(value)) return value[numericSource]
  return unavailable()
}

function cell(value: unknown): string {
  if (value === missing) return '저장된 규칙 없음'
  if (value === '') return '빈 문자열 ""'
  if (Array.isArray(value)) {
    return value.length === 0 ? '빈 목록 []' : `[${value.map(scalar).join(', ')}]`
  }
  return scalar(value)
}

function label(path: string): string {
  const meanings: Record<string, string> = {
    schemaVersion: '스키마 버전', contractId: '계약 식별자', version: '정책 버전', purpose: '업무 목적',
    allowedTools: '허용 도구', resourcePolicies: '객체 범위', caseScope: '대상 업무 건',
    documentScope: '대상 문서', customerScope: '고객 범위', type: '대상 고객',
    fieldPolicy: '필드 정책', allowed: '허용 필드', denyUnknown: '미등록 필드 거부',
    cardinality: '조회·반환 건수', maxRequestedRecords: '최대 요청 건수', maxReturnedRecords: '최대 반환 건수',
    externalEgress: '외부 반출', allowedDestinations: '허용 목적지', workflow: '업무 단계',
    allowedStages: '허용 업무 단계', highImpactActions: '고영향 행동 제한', toolTrust: '도구 신뢰',
    requireTrustedTool: '신뢰된 도구 필수', allowedTrustLevels: '허용 신뢰 등급', outputPolicy: '검토 결과',
    reviewStatusAllowed: '허용 검토 상태', metadata: '템플릿·검증기',
    templateVersion: '템플릿 버전', validatorVersion: '검증기 버전',
  }
  const parts = path.split('.')
  const field = parts[parts.length - 1]!
  const meaning = path === 'externalEgress.allowed' ? '외부 반출 허용'
    : path.startsWith('highImpactActions.') ? '고영향 행동 제한'
      : Object.hasOwn(meanings, field) ? meanings[field]!
        : meanings[parts[0]!] ?? '저장된 규칙'
  return `${meaning} (${path})`
}

function row(path: string, value: unknown): PolicyDisplayRow {
  return Object.freeze({ label: label(path), value: cell(value) })
}

function section(title: string, rows: PolicyDisplayRow[]): PolicyDisplaySection {
  return Object.freeze({ title, rows: Object.freeze(rows) })
}

function supportedFields(value: Fields, fields: readonly string[]): void {
  // This is a display coverage guard, not a policy validator: unsupported fields remain visible in raw.
  if (Object.keys(value).some(key => !fields.includes(key))) unavailable()
}

function fixedRows(value: unknown, path: string, fields: readonly string[]): PolicyDisplayRow[] {
  if (value === missing) return [row(path, missing)]
  if (value === null) return [row(path, null)]
  const source = object(value)
  supportedFields(source, fields)
  if (Object.keys(source).length === 0) return [Object.freeze({ label: label(path), value: '빈 객체 {}' })]
  return fields.map(field => row(`${path}.${field}`, own(source, field)))
}

function dynamicRows(value: unknown, path: string, fields?: readonly string[]): PolicyDisplayRow[] {
  if (value === missing) return [row(path, missing)]
  if (value === null) return [row(path, null)]
  const entries = Object.entries(object(value))
  if (entries.length === 0) return [Object.freeze({ label: label(path), value: '빈 객체 {}' })]
  return entries.flatMap(([tool, policy]) => fields
    ? fixedRows(policy, `${path}.${tool}`, fields)
    : [row(`${path}.${tool}`, policy)])
}

/** Presents supplied values only. Missing native numeric source or unsupported shapes retain raw display. */
export function projectPolicyRules(storedPolicyJson: string): PolicyRulesDisplay {
  try {
    if (typeof storedPolicyJson !== 'string') return raw
    const parsed: unknown = JSON.parse(storedPolicyJson,
      (_key: string, value: unknown, context?: { source?: unknown }): unknown => {
        if (typeof value !== 'number') return value
        if (typeof context?.source !== 'string') unavailable()
        return Object.freeze({ [numericSource]: context.source })
      })
    const policy = object(parsed)
    if (own(policy, 'schemaVersion') !== '1.0') return raw
    supportedFields(policy, [
      'schemaVersion', 'contractId', 'version', 'purpose', 'allowedTools', 'resourcePolicies',
      'customerScope', 'fieldPolicy', 'cardinality', 'externalEgress', 'workflow',
      'highImpactActions', 'toolTrust', 'outputPolicy', 'metadata',
    ])
    const sections = [
      section('기본 정보', ['schemaVersion', 'contractId', 'version', 'purpose']
        .map(field => row(field, own(policy, field)))),
      section('허용 도구', [row('allowedTools', own(policy, 'allowedTools'))]),
      section('객체·고객 범위', [
        ...dynamicRows(own(policy, 'resourcePolicies'), 'resourcePolicies', ['caseScope', 'documentScope']),
        ...fixedRows(own(policy, 'customerScope'), 'customerScope', ['type']),
      ]),
      section('허용 필드', dynamicRows(own(policy, 'fieldPolicy'), 'fieldPolicy', ['allowed', 'denyUnknown'])),
      section('조회·반환 건수', dynamicRows(own(policy, 'cardinality'), 'cardinality', ['maxRequestedRecords', 'maxReturnedRecords'])),
      section('외부 반출', fixedRows(own(policy, 'externalEgress'), 'externalEgress', ['allowed', 'allowedDestinations'])),
      section('업무 단계', fixedRows(own(policy, 'workflow'), 'workflow', ['allowedStages'])),
      section('사람 전용 행동', dynamicRows(own(policy, 'highImpactActions'), 'highImpactActions')),
      section('도구 신뢰', fixedRows(own(policy, 'toolTrust'), 'toolTrust', ['requireTrustedTool', 'allowedTrustLevels'])),
      section('검토 결과', fixedRows(own(policy, 'outputPolicy'), 'outputPolicy', ['reviewStatusAllowed'])),
      section('템플릿·검증기', fixedRows(own(policy, 'metadata'), 'metadata', ['templateVersion', 'validatorVersion'])),
    ]
    return Object.freeze({ kind: 'table', sections: Object.freeze(sections) })
  } catch {
    // SyntaxError and unsupported display details may contain policy text. They never leave this helper.
    return raw
  }
}
