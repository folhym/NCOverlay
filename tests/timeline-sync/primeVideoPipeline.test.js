import { describe, expect, test } from 'bun:test'

// Reuse the isolated browser-boundary pattern from Netflix fixtures. These
// synthetic responses do not establish Prime field meanings or clock semantics.
const primeProbe = String.raw`
import assert from 'node:assert/strict'
import { mock } from 'bun:test'

const mode = process.argv[1]
const secret = 'PRIVATE-SENTINEL'
const idA = 'PRIVATE-TITLE-ID-A'
const idB = 'PRIVATE-TITLE-ID-B'
const responses = new Map()
const logs = []
let pageHandler
let selectedEpisode = 1
let resolveInit
let patcher
const initReady = new Promise(resolve => { resolveInit = resolve })
const titleElem = { textContent: 'PRIVATE-SERIES-TITLE' }
const subtitleElem = { get textContent() { return 'S1 E' + selectedEpisode + ' PRIVATE-EPISODE-' + selectedEpisode } }

mock.module('#imports', () => ({ defineContentScript: config => config }))
mock.module('@/utils/logger', () => ({ logger: { log(...args) { logs.push(args) }, error() {} } }))
mock.module('@/utils/extension/page/checkVodEnable', () => ({ async checkVodEnable() { return true } }))
mock.module('@/utils/extension/checkVodEnable', () => ({ async checkVodEnable() { return true } }))
mock.module('@/utils/dom/querySelectorAsync', () => ({ async querySelectorAsync() { return titleElem } }))
mock.module('@/utils/sleep', () => ({ async sleep() {} }))
mock.module('@/messaging/page', () => ({
  onPageMessage(name, handler) { assert.equal(name, 'page:primeVideo:getPlaybackInfo'); pageHandler = handler },
  async sendPageMessage(name) { assert.equal(name, 'page:primeVideo:getPlaybackInfo'); return pageHandler() },
}))
mock.module('@/ncoverlay/patcher', () => ({ NCOPatcher: class {
  constructor(vod, init) { patcher = this; assert.equal(vod, 'primeVideo'); resolveInit(init) }
} }))
globalThis.location = { pathname: '/synthetic-prime' }
globalThis.document = { body: { querySelector() { return subtitleElem } } }
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.window = { async fetch(input) {
  const json = responses.get(input)
  assert.ok(json, 'Unexpected synthetic fetch URL')
  return new Response(JSON.stringify(json))
} }
globalThis.XMLHttpRequest = class {
  status = 200
  send(body) { this.sentBody = body; return 'original-send-result' }
}

const { default: pageScript } = await import('./src/entrypoints/page-primeVideo.content/index.ts')
pageScript.main()
for (let i = 0; i < 5 && !pageHandler; i++) await Promise.resolve()
assert.equal(typeof pageHandler, 'function')

function resources(full = 1440000) {
  return {
    title: secret, sessionization: { sessionHandoffToken: secret },
    __metadata: { id: secret },
    vodPlaylistedPlaybackUrls: { result: { playbackUrls: {
      fullTitleDurationMs: full,
      intraTitlePlaylist: [
        { type: 'Main', startMs: 0, endMs: 600000, shouldShowOnScrubBar: true },
        { type: 'Remote', startMs: 600000, endMs: 690000,
          urls: [{ url: 'https://cdn.invalid/' + secret + '?token=' + secret, consumptionId: secret }],
          urlsInPriorityOrder: [secret], nonLinearAds: [{ url: secret, token: secret }] },
        { type: 'Main', startMs: 690000, endMs: full },
      ],
    } } },
    transitionTimecodes: { result: { events: [
      { eventType: 'X', startTimeMs: 600000, intervals: [{ startTimeMs: 600000 }, { startTimeMs: 690000 }], titleId: secret },
      { eventType: 'Future_Type', startTimeMs: 1000000, intervals: [{ startTimeMs: 1000000 }] },
    ] } },
  }
}
function catalog(episode) {
  return { resources: { catalogMetadataV2: { catalog: {
    type: 'EPISODE', seriesTitle: titleElem.textContent,
    title: 'PRIVATE-EPISODE-' + episode, seasonNumber: 1, episodeNumber: episode,
  } } } }
}
function url(kind, id) {
  return kind === 'playback'
    ? 'https://prime.invalid/GetVodPlaybackResources?titleId=' + id + '&token=' + secret
    : 'https://prime.invalid/playerChromeResources/v1?entityId=' + id + '&catalogMetadataV2=true'
}
async function deliver(kind, id, json) {
  const address = url(kind, id)
  if (mode === 'xhr') {
    const xhr = new XMLHttpRequest()
    xhr.responseURL = address; xhr.responseText = JSON.stringify(json)
    const event = {}
    let called = false
    xhr.onload = function(received) { called = true; assert.equal(this, xhr); assert.equal(received, event); return 'original-load-result' }
    assert.equal(xhr.send('PRIVATE-BODY'), 'original-send-result')
    assert.equal(xhr.sentBody, 'PRIVATE-BODY')
    assert.equal(xhr.onload(event), 'original-load-result')
    assert.equal(called, true)
  } else {
    responses.set(address, json)
    const response = await window.fetch(address)
    assert.equal(response.bodyUsed, false, 'Only a clone may be inspected')
    assert.deepEqual(await response.json(), json)
  }
}

const raw = resources()
if (mode === 'missing') {
  delete raw.transitionTimecodes
  delete raw.vodPlaylistedPlaybackUrls.result.playbackUrls.intraTitlePlaylist
} else if (mode === 'malformed') {
  raw.transitionTimecodes = { result: { events: [null, { eventType: 'Future_Type', startTimeMs: 'bad', intervals: [null, { startTimeMs: -1 }] }] } }
  raw.vodPlaylistedPlaybackUrls.result.playbackUrls.intraTitlePlaylist = [null, { type: 'Remote', startMs: 5, endMs: 1 }]
}
await deliver('playback', idA, raw)
await deliver('catalog', idA, catalog(1))
let packet = await pageHandler()
assert.equal(packet.id, idA)
assert.deepEqual(packet.playbackUrls, raw.vodPlaylistedPlaybackUrls.result.playbackUrls)
assert.deepEqual(packet.catalog, catalog(1).resources.catalogMetadataV2.catalog)
assert.ok(!JSON.stringify(packet.timelineEvidence).includes('PRIVATE-'))
assert.ok(!('transitionTimecodes' in packet), 'Do not forward the raw result')
assert.ok(!('sessionization' in packet))

if (mode === 'repeat') {
  await deliver('playback', idA, resources(1200000))
  const repeated = await pageHandler()
  assert.deepEqual(repeated, packet, 'Preserve the first-response cache policy atomically')
} else if (mode === 'identity') {
  await deliver('playback', idB, resources(1600000))
  await deliver('catalog', idB, catalog(2))
  selectedEpisode = 2
  packet = await pageHandler()
  assert.equal(packet.id, idB)
  assert.equal(packet.timelineEvidence.fullTitleDurationMs, 1600000)
  assert.equal(packet.playbackUrls.fullTitleDurationMs, 1600000)
} else if (mode === 'eviction') {
  for (let i = 0; i < 25; i++) await deliver('playback', 'PRIVATE-OTHER-ID-' + i, resources())
  assert.equal(await pageHandler(), null, 'Playback/evidence leave the 25-item LRU together')
}

const { default: vodScript } = await import('./src/entrypoints/vod-primeVideo.content/index.ts')
vodScript.main()
const init = await initReady
const video = Object.assign(new EventTarget(), { duration: 1560.5, currentTime: 123.25 })
const overlay = { video, async clear() {}, async dispose() {}, state: {
  async get() { return null }, async set() {}, onChange() { return () => {} },
} }
patcher.nco = overlay
const request = {}
let info, failure
try { info = await init.getInfo(overlay, request) } catch (error) { failure = error }
const diagnosticLogs = logs.filter(([event]) => event === 'primeVideo.timelineEvidence')
if (mode === 'eviction') {
  assert.ok(failure)
  assert.equal(request.failureLogged, true)
  assert.equal(request.isCurrent(), false)
  assert.equal(logs.filter(([event,data])=>event==='primeVideo.getInfo'&&data.stage==='exhausted'&&data.failure==='metadata-missing').length,1)
  assert.equal(diagnosticLogs.length, 1)
  assert.equal(diagnosticLogs[0][1].status, 'resource-unavailable')
  assert.equal(diagnosticLogs[0][1].fullTitleDurationMs, null)
  assert.deepEqual(diagnosticLogs[0][1].transitionEvents, [])
} else {
  assert.equal(failure, undefined)
  assert.equal(info.duration, mode === 'identity' ? 1600 : 1440)
  assert.ok(info.input.includes(titleElem.textContent))
  assert.equal(info.providerTimeline, undefined)
  assert.equal(diagnosticLogs.length, 1)
  const diagnostic = diagnosticLogs[0][1]
  assert.equal(diagnostic.status, 'awaiting-field-verification')
  assert.equal(diagnostic.mediaDurationMs, 1560500)
  assert.equal(diagnostic.mediaCurrentTimeMs, 123250)
  assert.equal(diagnostic.fullTitleDurationMs, info.duration * 1000)
  assert.ok(!JSON.stringify(diagnostic).includes('PRIVATE-'))
  assert.ok(!JSON.stringify(diagnostic).includes('https://'))
  assert.ok(!('providerTimeline' in diagnostic))
  assert.ok(!('alignments' in diagnostic))
  if (mode === 'missing') {
    assert.deepEqual(diagnostic.intraTitlePlaylist, [])
    assert.deepEqual(diagnostic.transitionEvents, [])
  } else if (mode === 'malformed') {
    assert.equal(diagnostic.intraTitlePlaylist[0].rangeStatus, 'invalid')
    assert.equal(diagnostic.intraTitlePlaylist[1].rangeStatus, 'invalid')
    assert.equal(diagnostic.transitionEvents[1].startTimeMs, null)
    assert.deepEqual(diagnostic.transitionEvents[1].intervalStartTimesMs, [null, null])
  } else {
    assert.deepEqual(diagnostic.intraTitlePlaylist.map(entry => entry.type), ['Main', 'Remote', 'Main'])
    assert.equal(diagnostic.intraTitlePlaylist[1].nonLinearAdsCount, 1)
    assert.deepEqual(diagnostic.transitionEvents[0].intervalStartTimesMs, [600000, 690000])
  }
  video.currentTime = 500
  const again = await init.getInfo(overlay, {})
  assert.deepEqual(again, info, 'A later media sample never changes searching or creates synchronization')
  assert.equal(logs.filter(([event]) => event === 'primeVideo.timelineEvidence').at(-1)[1].mediaCurrentTimeMs, 500000)
}
assert.ok(!logs.some(([event]) => event === 'getPlaybackInfo'), 'Avoid the raw URL/catalog log')
console.log('prime-pipeline-pass:' + mode)
`

describe('actual Prime resource-to-diagnostic pipeline fixtures', () => {
  for (const mode of [
    'fetch',
    'xhr',
    'missing',
    'malformed',
    'repeat',
    'identity',
    'eviction',
  ]) {
    test(mode, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', primeProbe, mode],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(
        `prime-pipeline-pass:${mode}`
      )
    })
  }
})
