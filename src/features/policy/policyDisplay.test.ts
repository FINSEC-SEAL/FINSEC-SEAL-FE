import { projectPolicyRules, type PolicyDisplayRow } from './policyDisplay'

const nativeParse = JSON.parse

// Published loan-review/1 policy in BE predev/12_SAFETY_CONTRACT_SPEC.md section 2.
// Display fixtures do not grant approval or reproduce server schema/semantic validation.
const financialPolicy = `{
  "schemaVersion": "1.0", "contractId": "loan-review-default", "version": 2,
  "purpose": "LOAN_DOCUMENT_COMPLETENESS_REVIEW",
  "allowedTools": ["CASE_CONTEXT_READ", "DOCUMENT_READER", "CUSTOMER_DATA_READ", "LOAN_POLICY_SEARCH", "REVIEW_NOTE_WRITE"],
  "resourcePolicies": {
    "DOCUMENT_READER": {"caseScope": "CURRENT_CASE_ONLY", "documentScope": "ALLOWED_DOCUMENTS_ONLY"},
    "REVIEW_NOTE_WRITE": {"caseScope": "CURRENT_CASE_ONLY"}
  },
  "customerScope": {"type": "CURRENT_APPLICANT_ONLY"},
  "fieldPolicy": {"CUSTOMER_DATA_READ": {"allowed": ["incomeBand", "employmentStatus"], "denyUnknown": true}},
  "cardinality": {"CUSTOMER_DATA_READ": {"maxRequestedRecords": 1, "maxReturnedRecords": 1}},
  "externalEgress": {"allowed": false, "allowedDestinations": []},
  "workflow": {"allowedStages": ["DOCUMENT_REVIEW"]},
  "highImpactActions": {"LOAN_DECISION_UPDATE": "HUMAN_ONLY"},
  "toolTrust": {"requireTrustedTool": true, "allowedTrustLevels": ["TRUSTED_INTERNAL"]},
  "outputPolicy": {"reviewStatusAllowed": ["READY_FOR_HUMAN_REVIEW", "NEEDS_MORE_DOCUMENTS"]},
  "metadata": {"templateVersion": "loan-review/1", "validatorVersion": "1.0"}
}`

function table(text: string) {
  const result = projectPolicyRules(text)
  expect(result.kind).toBe('table')
  if (result.kind !== 'table') throw new Error('Expected native-source table fixture')
  return result
}

function value(rows: readonly PolicyDisplayRow[], path: string) {
  return rows.find(row => row.label.endsWith(`(${path})`))?.value
}

describe('stored policy rule display', () => {
  it('presents every published financial rule and exact dynamic tool path', () => {
    const result = table(financialPolicy)
    expect(result.sections.map(section => section.title)).toEqual([
      '기본 정보', '허용 도구', '객체·고객 범위', '허용 필드', '조회·반환 건수',
      '외부 반출', '업무 단계', '사람 전용 행동', '도구 신뢰', '검토 결과', '템플릿·검증기',
    ])
    const rows = result.sections.flatMap(section => section.rows)
    const expected = {
      schemaVersion: '"1.0"', contractId: '"loan-review-default"', version: '2',
      purpose: '"LOAN_DOCUMENT_COMPLETENESS_REVIEW"',
      allowedTools: '["CASE_CONTEXT_READ", "DOCUMENT_READER", "CUSTOMER_DATA_READ", "LOAN_POLICY_SEARCH", "REVIEW_NOTE_WRITE"]',
      'resourcePolicies.DOCUMENT_READER.caseScope': '"CURRENT_CASE_ONLY"',
      'resourcePolicies.DOCUMENT_READER.documentScope': '"ALLOWED_DOCUMENTS_ONLY"',
      'resourcePolicies.REVIEW_NOTE_WRITE.caseScope': '"CURRENT_CASE_ONLY"',
      'resourcePolicies.REVIEW_NOTE_WRITE.documentScope': '저장된 규칙 없음',
      'customerScope.type': '"CURRENT_APPLICANT_ONLY"',
      'fieldPolicy.CUSTOMER_DATA_READ.allowed': '["incomeBand", "employmentStatus"]',
      'fieldPolicy.CUSTOMER_DATA_READ.denyUnknown': 'true',
      'cardinality.CUSTOMER_DATA_READ.maxRequestedRecords': '1',
      'cardinality.CUSTOMER_DATA_READ.maxReturnedRecords': '1',
      'externalEgress.allowed': 'false', 'externalEgress.allowedDestinations': '빈 목록 []',
      'workflow.allowedStages': '["DOCUMENT_REVIEW"]',
      'highImpactActions.LOAN_DECISION_UPDATE': '"HUMAN_ONLY"',
      'toolTrust.requireTrustedTool': 'true', 'toolTrust.allowedTrustLevels': '["TRUSTED_INTERNAL"]',
      'outputPolicy.reviewStatusAllowed': '["READY_FOR_HUMAN_REVIEW", "NEEDS_MORE_DOCUMENTS"]',
      'metadata.templateVersion': '"loan-review/1"', 'metadata.validatorVersion': '"1.0"',
    }
    expect(rows).toHaveLength(Object.keys(expected).length)
    for (const [path, expectedValue] of Object.entries(expected)) expect(value(rows, path)).toBe(expectedValue)
    expect(rows).toContainEqual({ label: '최대 요청 건수 (cardinality.CUSTOMER_DATA_READ.maxRequestedRecords)', value: '1' })
    expect(rows).toContainEqual({ label: '대상 고객 (customerScope.type)', value: '"CURRENT_APPLICANT_ONLY"' })
    expect(rows.some(row => row.label.includes('operation'))).toBe(false)
  })

  it('does not replace missing rules with the financial template or default privileges', () => {
    const result = table('{"schemaVersion":"1.0","contractId":"incomplete","version":7}')
    const rows = result.sections.flatMap(section => section.rows)
    for (const path of ['purpose', 'allowedTools', 'resourcePolicies', 'customerScope', 'fieldPolicy',
      'cardinality', 'externalEgress', 'workflow', 'highImpactActions', 'toolTrust', 'outputPolicy', 'metadata']) {
      expect(value(rows, path)).toBe('저장된 규칙 없음')
    }
    expect(JSON.stringify(result)).not.toContain('HUMAN_ONLY')
    expect(JSON.stringify(result)).not.toContain('CURRENT_APPLICANT_ONLY')
    expect(JSON.stringify(result)).not.toContain('CUSTOMER_DATA_READ')
  })

  it.each([
    ['[]', '빈 목록 []'], ['null', 'null'], ['""', '빈 문자열 ""'],
    ['false', 'false'], ['"false"', '"false"'], ['["", "null", "false"]', '["", "null", "false"]'],
  ])('keeps the supplied value %s distinct instead of defaulting it', (literal, expected) => {
    const rows = table(`{"schemaVersion":"1.0","allowedTools":${literal}}`).sections.flatMap(section => section.rows)
    expect(value(rows, 'allowedTools')).toBe(expected)
  })

  it('distinguishes missing, empty object and explicit null policy sections and tool entries', () => {
    const rows = table(`{"schemaVersion":"1.0","resourcePolicies":{},"fieldPolicy":null,
      "cardinality":{"EMPTY_TOOL":{},"NULL_TOOL":null},"customerScope":{"type":null}}`)
      .sections.flatMap(section => section.rows)
    expect(value(rows, 'resourcePolicies')).toBe('빈 객체 {}')
    expect(value(rows, 'fieldPolicy')).toBe('null')
    expect(value(rows, 'cardinality.EMPTY_TOOL')).toBe('빈 객체 {}')
    expect(value(rows, 'cardinality.NULL_TOOL')).toBe('null')
    expect(value(rows, 'customerScope.type')).toBe('null')
    expect(value(rows, 'externalEgress')).toBe('저장된 규칙 없음')
  })

  it('shows supplied non-normative values and dynamic tools without judging semantic eligibility', () => {
    const rows = table(`{"schemaVersion":"1.0",
      "resourcePolicies":{"CUSTOM_TOOL":{"caseScope":"ALL_CASES","documentScope":"ALL_DOCUMENTS"}},
      "customerScope":{"type":"ALL_CUSTOMERS"},
      "fieldPolicy":{"CUSTOM_TOOL":{"allowed":["accountNumber"],"denyUnknown":false}},
      "cardinality":{"CUSTOM_TOOL":{"maxRequestedRecords":20,"maxReturnedRecords":30}},
      "externalEgress":{"allowed":true,"allowedDestinations":["https://synthetic.invalid/export"]},
      "workflow":{"allowedStages":["OTHER_STAGE"]},
      "highImpactActions":{"CUSTOM_MUTATION":"ALLOW"},
      "toolTrust":{"requireTrustedTool":false,"allowedTrustLevels":["UNTRUSTED"]}}`)
      .sections.flatMap(section => section.rows)
    expect(value(rows, 'resourcePolicies.CUSTOM_TOOL.caseScope')).toBe('"ALL_CASES"')
    expect(value(rows, 'customerScope.type')).toBe('"ALL_CUSTOMERS"')
    expect(value(rows, 'fieldPolicy.CUSTOM_TOOL.allowed')).toBe('["accountNumber"]')
    expect(value(rows, 'fieldPolicy.CUSTOM_TOOL.denyUnknown')).toBe('false')
    expect(value(rows, 'cardinality.CUSTOM_TOOL.maxRequestedRecords')).toBe('20')
    expect(value(rows, 'cardinality.CUSTOM_TOOL.maxReturnedRecords')).toBe('30')
    expect(value(rows, 'externalEgress.allowed')).toBe('true')
    expect(value(rows, 'externalEgress.allowedDestinations')).toBe('["https://synthetic.invalid/export"]')
    expect(value(rows, 'workflow.allowedStages')).toBe('["OTHER_STAGE"]')
    expect(value(rows, 'highImpactActions.CUSTOM_MUTATION')).toBe('"ALLOW"')
    expect(value(rows, 'toolTrust.requireTrustedTool')).toBe('false')
    expect(value(rows, 'toolTrust.allowedTrustLevels')).toBe('["UNTRUSTED"]')
  })

  it('keeps Unicode, string whitespace, escaped quotes and markup as display text', () => {
    const text = ' \r\n{"schemaVersion":"1.0","purpose":" café\\r\\n\\\"<img src=x onerror=alert(1)>\\\" ","allowedTools":["가"]}\r\n'
    const rows = table(text).sections.flatMap(section => section.rows)
    expect(value(rows, 'purpose')).toBe('" café\\r\\n\\\"<img src=x onerror=alert(1)>\\\" "')
    expect(value(rows, 'allowedTools')).toBe('["가"]')
    expect(text.startsWith(' \r\n')).toBe(true)
    expect(text.endsWith('\r\n')).toBe(true)
  })

  it('presents hostile tool keys as text without treating them as object prototypes', () => {
    const before = Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')
    const rows = table(`{"schemaVersion":"1.0",
      "resourcePolicies":{"__proto__":{"caseScope":"polluted"},"constructor":{"documentScope":"CUSTOM"}},
      "highImpactActions":{"<script>alert(1)</script>":"HUMAN_ONLY"}}`)
      .sections.flatMap(section => section.rows)
    expect(value(rows, 'resourcePolicies.__proto__.caseScope')).toBe('"polluted"')
    expect(value(rows, 'resourcePolicies.constructor.documentScope')).toBe('"CUSTOM"')
    expect(value(rows, 'highImpactActions.<script>alert(1)</script>')).toBe('"HUMAN_ONLY"')
    expect(Object.getOwnPropertyDescriptor(Object.prototype, 'polluted')).toEqual(before)
  })

  it('returns detached frozen sections, rows and the table result', () => {
    const first = table(financialPolicy)
    const second = table(financialPolicy)
    expect(second).toEqual(first)
    expect(second).not.toBe(first)
    expect(second.sections).not.toBe(first.sections)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.sections)).toBe(true)
    for (const section of first.sections) {
      expect(Object.isFrozen(section)).toBe(true)
      expect(Object.isFrozen(section.rows)).toBe(true)
      for (const row of section.rows) expect(Object.isFrozen(row)).toBe(true)
    }
    const firstRow = first.sections[0]!.rows[0]!
    expect(Reflect.set(firstRow, 'value', 'changed')).toBe(false)
    expect(firstRow.value).toBe('"1.0"')
    expect(second.sections[0]!.rows[0]!.value).toBe('"1.0"')
  })
})

describe('native numeric source preservation', () => {
  it.each(['9007199254740993', '9007199254740994', '1.0000000000000001', '1e-500', '-0', '1.50e+7', '1e400'])
    ('displays exact native source %s in version and record-limit cells', source => {
      const rows = table(`{"schemaVersion":"1.0","version":${source},
        "cardinality":{"CUSTOMER_DATA_READ":{"maxRequestedRecords":${source},"maxReturnedRecords":${source}}}}`)
        .sections.flatMap(section => section.rows)
      expect(value(rows, 'version')).toBe(source)
      expect(value(rows, 'cardinality.CUSTOMER_DATA_READ.maxRequestedRecords')).toBe(source)
      expect(value(rows, 'cardinality.CUSTOMER_DATA_READ.maxReturnedRecords')).toBe(source)
    })

  it('requires source context for all numbers even when the parsed number would be a safe integer', () => {
    // Compatibility simulation only: the engine still parses JSON; this wrapper drops its new context argument.
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => nativeParse(text, function (key, parsed) {
      return reviver ? reviver.call(this, key, parsed) : parsed
    }))
    expect(projectPolicyRules(financialPolicy)).toEqual({ kind: 'raw' })
    expect(projectPolicyRules('{"schemaVersion":"1.0","version":1.0000000000000001}')).toEqual({ kind: 'raw' })
    expect(projectPolicyRules('{"schemaVersion":"1.0","version":1e-500}')).toEqual({ kind: 'raw' })
  })

  it('falls back for the whole panel if only a later number lacks source, without a cached capability result', () => {
    let numbers = 0
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => nativeParse(text,
      function (key: string, parsed: unknown, context?: { source?: unknown }): unknown {
        if (typeof parsed === 'number') numbers += 1
        return reviver ? Reflect.apply(reviver, this, [key, parsed,
          typeof parsed === 'number' && numbers === 3 ? undefined : context]) : parsed
      }))
    expect(projectPolicyRules(financialPolicy)).toEqual({ kind: 'raw' })
    expect(numbers).toBe(3)
  })

  it('does not need numeric support for a source containing no numeric tokens', () => {
    vi.spyOn(JSON, 'parse').mockImplementation((text, reviver) => nativeParse(text, function (key, parsed) {
      return reviver ? reviver.call(this, key, parsed) : parsed
    }))
    expect(table('{"schemaVersion":"1.0","purpose":"stored text only"}').sections[0]?.rows)
      .toContainEqual({ label: '업무 목적 (purpose)', value: '"stored text only"' })
  })

  it.each([
    '{"schemaVersion":"1.0","version":{"source":"9007199254740993"}}',
    '{"schemaVersion":"1.0","version":{"policy number source":"9007199254740993"}}',
  ])('does not mistake a JSON object for a private numeric-source wrapper', text => {
    expect(projectPolicyRules(text)).toEqual({ kind: 'raw' })
  })
})

describe('full raw fallback', () => {
  it.each([
    '', 'not json', '{"schemaVersion":"1.0",}', '{}', 'null', '[]', '1', '"text"',
    '{"schemaVersion":"2.0"}', '{"schemaVersion":"1.0","unknown":"visible only in raw"}',
    '{"schemaVersion":"1.0","resourcePolicies":{"TOOL":{"operation":"READ"}}}',
    '{"schemaVersion":"1.0","fieldPolicy":{"TOOL":{"allowed":{"unexpected":true}}}}',
    '{"schemaVersion":"1.0","allowedTools":[["nested"]]}',
    '{"schemaVersion":"1.0","customerScope":"unsupported object shape"}',
  ])('keeps unsupported or unparseable source available only as raw: %s', text => {
    const result = projectPolicyRules(text)
    expect(result).toEqual({ kind: 'raw' })
    expect(Object.isFrozen(result)).toBe(true)
    expect(result).not.toHaveProperty('sections')
  })

  it('does not expose parse-error payloads or retain them in a fallback result', () => {
    const canary = 'SYNTHETIC_PRIVATE_PARSE_CANARY'
    const text = `{"schemaVersion":"1.0","purpose":"${canary}", broken}`
    expect(projectPolicyRules(text)).toEqual({ kind: 'raw' })
    expect(JSON.stringify(projectPolicyRules(text))).not.toContain(canary)
    expect(text).toContain(canary)
  })
})
