import { createDemoPlatform, DEMO_AGENT_ID, DEMO_RELEASE_ID, demoManifest } from './platform'

describe('isolated UI fixture adapter', () => {
  it('does not export a synthetic attestation or invent one before completion', async () => {
    const client = createDemoPlatform()
    await expect(client.attestation(DEMO_RELEASE_ID, 'demo')).rejects.toThrow('아직 완료된 보고서')
    client.setReportReady(true)
    expect((await client.attestation(DEMO_RELEASE_ID, 'demo')).document.decision).toEqual({value:'BLOCKED'})
    await expect(client.downloadAttestation(DEMO_RELEASE_ID, 'html', 'demo')).rejects.toThrow('내보낼 수 없습니다')
    client.setReportReady(false)
    await expect(client.attestation(DEMO_RELEASE_ID, 'demo')).rejects.toThrow('아직 완료된 보고서')
  })
  it('registers preview inventory without any HTTP request or shared mutable data', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const first = createDemoPlatform(), second = createDemoPlatform()
    await first.createAgent({agentKey:'new-agent',name:'New Agent',purposeSummary:'Synthetic UI'}, 'demo')
    expect(await first.listAgents('demo')).toHaveLength(2)
    expect(await second.listAgents('demo')).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('rejects duplicate versions and archived-agent releases', async () => {
    const client = createDemoPlatform()
    await client.createRelease(DEMO_AGENT_ID, JSON.parse(demoManifest), 'demo')
    await expect(client.createRelease(DEMO_AGENT_ID, JSON.parse(demoManifest), 'demo')).rejects.toThrow('이미 등록된 버전')
    await client.archiveAgent(DEMO_AGENT_ID, 'demo')
    await expect(client.createRelease(DEMO_AGENT_ID, JSON.parse(demoManifest), 'demo')).rejects.toThrow('활성 에이전트')
  })
  it('labels a demo validator as structural preview, not real security verification', async () => {
    const client = createDemoPlatform()
    const r = await client.createRelease(DEMO_AGENT_ID, JSON.parse(demoManifest), 'demo')
    await expect(client.fingerprint(r.id, 'demo')).rejects.toThrow('먼저 구성을 분석')
    const validation = await client.validateRelease(r.id, 'demo')
    expect(validation.issues[0]?.code).toBe('DEMO_ONLY')
    const analyzed = await client.analyzeRelease(r.id, 'demo')
    expect(analyzed.lifecycleState).toBe('ANALYZED')
    expect((await client.fingerprint(r.id, 'demo')).canonicalizationVersion).toBe('DEMO_ONLY')
    await expect(client.attestation(r.id, 'demo')).rejects.toThrow('아직 완료된 보고서')
  })
})
