import { describe, expect, test } from 'bun:test'

// Actual Prime entrypoint, Patcher, NCOverlay info watcher, State and Core.
// Only browser IO, settings and canvas rendering are replaced in this process.
const probe = String.raw`
import assert from 'node:assert/strict'
import { mock } from 'bun:test'
const mode = process.argv[1]
const stored = new Map(), listeners = new Map(), logs = [], errors = []
let observer, patcher, init, capture, clock = 0, searches = 0
const captured = new Promise(resolve => { capture = resolve })
let episode = 1, delayedReply, blockGet, blockSet
const values = {
  'comment:speed': 1, 'comment:customize': {}, 'comment:hideAssistedComments': false,
  'comment:adjustJikkyoOffset': false, 'autoSearch:jikkyoOnlyAdjustable': false,
  'ng:sharingLevel': 'none', 'autoSearch:manual': false,
  'autoSearch:targets': ['official', 'danime', 'chapter', 'jikkyo'],
  'autoSearch:jikkyoChannelIds': [], 'autoSearch:jikkyoIgnoreRerun': false,
}
mock.module('#imports', () => ({ defineContentScript: config => config }))
mock.module('@/utils/logger', () => ({ logger: {
  log(...args) { logs.push(args) }, error(_context, error) { errors.push(error.message) },
} }))
mock.module('@/utils/settings/extension', () => ({ settings: {
  async get(...keys) {
    const result = keys.map(key => { assert.ok(key in values, key); return values[key] })
    return keys.length === 1 ? result[0] : result
  }, watch() { return () => {} }, onChange() { return () => {} },
} }))
function notify(key, value, old) {
  for (const callback of listeners.get(key) ?? []) callback(value, old)
}
mock.module('@/utils/storage/extension', () => ({ storage: {
  async get(key) {
    const snapshot = stored.get(key) ?? null
    if (key === 'state:1:info' && blockGet) {
      const deferred = blockGet; blockGet = null; await deferred.promise
    }
    return snapshot
  },
  async set(key, value) {
    if (key === 'state:1:info' && blockSet) {
      const deferred = blockSet; blockSet = null; deferred.started(); await deferred.promise
    }
    const old = stored.get(key) ?? null
    const copy = structuredClone(value)
    stored.set(key, copy); notify(key, copy, old)
  },
  async remove(key) {
    const old = stored.get(key) ?? null
    stored.delete(key); notify(key, null, old)
  },
  onChange(key, callback) {
    if (!listeners.has(key)) listeners.set(key, new Set())
    listeners.get(key).add(callback)
    return () => listeners.get(key).delete(callback)
  },
} }))
mock.module('@/utils/api/niconico/getNgSettings', () => ({
  async getNgSettings() { return { words: [], commands: [], ids: [] } },
}))
mock.module('@/utils/extension/checkVodEnable', () => ({ async checkVodEnable() { return true } }))
mock.module('@/utils/sleep', () => ({ async sleep() {} }))
mock.module('@/utils/webext', () => ({ webext: { runtime: {
  connect() { return { onMessage: { addListener() {} }, disconnect() {} } },
} } }))
mock.module('@/messaging/extension', () => ({
  async sendExtensionMessage(name) { return name === 'bg:getCurrentTab' ? { id: 1 } : null },
  onExtensionMessage() { return () => {} },
}))
mock.module('@/ncoverlay/keyboard', () => ({ NCOKeyboard: class { dispose() {} } }))
mock.module('@/ncoverlay/searcher', () => ({ NCOSearcher: class {
  async autoSearch(args) { searches++; assert.deepEqual(args.targets, ['official', 'danime', 'chapter']) }
} }))
mock.module('@/ncoverlay/renderer', () => ({ NCORenderer: class {
  constructor(video) { this.video = video; this.canvas = {}; this.offset = 0; this.refreshes = 0 }
  setThreads(threads) { this.threads = threads; this.refreshes++ }
  setOffset(offset) { this.offset = offset }
  getCurrentTime() { return this.video.currentTime }
  reload() {} clear() {} dispose() {} start() {} stop() {} rerender() {}
} }))
const { NCOverlay: RealOverlay } = await import('./src/ncoverlay/index.ts')
class Overlay extends RealOverlay {
  callbacks = new Map()
  addEventListener(event, callback) {
    super.addEventListener(event, callback)
    if (!this.callbacks.has(event)) this.callbacks.set(event, [])
    this.callbacks.get(event).push(callback)
  }
  async dispatch(event) { for (const callback of this.callbacks.get(event) ?? []) await callback.call(this) }
}
mock.module('@/ncoverlay/index', () => ({ NCOverlay: Overlay }))
const { NCOPatcher: RealPatcher } = await import('./src/ncoverlay/patcher.ts')
mock.module('@/ncoverlay/patcher', () => ({ NCOPatcher: class extends RealPatcher {
  constructor(vod, config) { super(vod, config); patcher = this; init = config; capture(this) }
} }))
const { extractPrimeTimelineEvidence } = await import('./src/timeline-sync/providers/primeVideo.ts')
function packet(number = episode) {
  const fullTitleDurationMs = number === 1 ? 1425000 : 1426000
  const points = number === 1 ? [492158, 1117574] : [433975, 846095]
  const ends = [...points, fullTitleDurationMs]
  const playbackUrls = { fullTitleDurationMs, intraTitlePlaylist: ends.flatMap((end, index) => [
    ...(index ? [{ type: 'Remote' }] : []),
    { type: 'Main', startMs: index ? ends[index - 1] : 0, endMs: end },
  ]) }
  return { id: 'PRIVATE-ID-' + number, playbackUrls,
    catalog: { type: mode === 'movie' ? 'MOVIE' : 'EPISODE',
      seriesTitle: 'PRIVATE-SERIES', title: 'PRIVATE-EPISODE-' + number,
      seasonNumber: 1, episodeNumber: number },
    timelineEvidence: extractPrimeTimelineEvidence({ vodPlaylistedPlaybackUrls: { result: { playbackUrls } } }),
  }
}
mock.module('@/messaging/page', () => ({ async sendPageMessage() {
  const reply = packet()
  if (delayedReply) return delayedReply(reply)
  return reply
} }))
class Video extends EventTarget {
  duration = 1425; currentTime = 0; readyState = 0; paused = true
  src = 'blob:fixture'; visible = true; durationListeners = new Set()
  addEventListener(type, callback, ...args) {
    if (type === 'durationchange') this.durationListeners.add(callback)
    return super.addEventListener(type, callback, ...args)
  }
  removeEventListener(type, callback, ...args) {
    if (type === 'durationchange') this.durationListeners.delete(callback)
    return super.removeEventListener(type, callback, ...args)
  }
  checkVisibility() { return this.visible }
  closest() { return { querySelector() { return { insertAdjacentElement() {} } } } }
}
let selectedVideo = new Video()
globalThis.HTMLMediaElement = { HAVE_METADATA: 1 }
globalThis.location = { pathname: '/synthetic-prime' }
globalThis.performance = { now() { clock += 2000; return clock } }
globalThis.document = { body: { querySelector(selector) {
  if (selector.includes('video[src]')) return selectedVideo
  return { textContent: selector.includes('title-text:') ? 'PRIVATE-SERIES' : 'S1 E' + episode }
} } }
globalThis.MutationObserver = class {
  constructor(callback) { observer = this; this.callback = callback }
  observe() {} disconnect() {}
}
const { default: script } = await import('./src/entrypoints/vod-primeVideo.content/index.ts')
script.main(); await captured; await patcher.setVideo(selectedVideo)
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve() }
const load = async (event = 'loadedmetadata') => { await patcher.nco.dispatch(event); await flush() }
const state = () => patcher.nco.state
const info = () => state().get('info')
async function seed() {
  const old = await info()
  await state().set('info', { ...old, chapters: [{ start: 10, end: 20 }], isNhkOndemand: true })
  await state().set('slots', [{ id: 'manual', isAutoLoaded: false, threads: [{
    id: 'thread', fork: 'main', commentCount: 2, comments: [492158, 1117574].map((vposMs, index) => ({
      id: String(index), body: 'ordinary-' + index, vposMs, commands: [],
      userId: 'fixture', score: 0, isPremium: false,
    })),
  }] }])
  await state().set('slotDetails', [{ id: 'manual', type: 'official', status: 'ready', offsetMs: 5000, isAutoLoaded: false }])
  await state().set('offset', 2); await flush()
}
async function change(duration, position, video = selectedVideo) {
  video.duration = duration; video.currentTime = position
  video.dispatchEvent(new Event('durationchange')); await flush()
}
function positions() { return patcher.nco.renderer.threads[0].comments.map(comment => comment.vposMs) }
async function first() { await change(1457.782, mode === 'after' ? 526.13374 : 490.876409) }
await load()
if (mode === 'movie') {
  assert.equal((await info()).providerTimeline, undefined)
  assert.equal(selectedVideo.durationListeners.size, 0)
  await seed(); await first(); assert.deepEqual(positions(), [497158, 1122574])
} else {
  assert.equal((await info()).providerTimeline.alignments.length, 1)
  assert.equal(selectedVideo.durationListeners.size, 1)
  await seed()
  const searchCount = searches, original = await info(), raw = JSON.stringify(await state().get('slots'))
  await first()
  assert.equal((await info()).providerTimeline.alignments[1].targetTimeMs, 524940)
  assert.deepEqual(positions(), [529940, 1155356])
  assert.equal(patcher.nco.renderer.offset, 2)
  assert.equal(positions()[0] + patcher.nco.renderer.offset * 1000, 531940)
  if (['before', 'after', 'reload'].includes(mode)) {
    if (mode === 'reload') {
      await load('reload')
      assert.equal(selectedVideo.durationListeners.size, 1)
      assert.equal((await info()).providerTimeline.alignments[1].targetTimeMs, 524940)
    }
    const refreshed = patcher.nco.renderer.refreshes
    await change(1506.372, mode === 'after' ? 1200.543033 : 1148.940833)
    assert.deepEqual(positions(), [529940, 1203946])
    assert.ok(patcher.nco.renderer.refreshes > refreshed)
    assert.equal((await info()).providerTimeline.alignments[2].targetTimeMs, 1198946)
    assert.equal(positions()[1] + patcher.nco.renderer.offset * 1000, 1205946)
    assert.equal((await info()).duration, 1425)
    if (mode !== 'reload') {
      const { providerTimeline: _a, ...preserved } = await info()
      const { providerTimeline: _b, ...expected } = original
      assert.deepEqual(preserved, expected)
      assert.equal(searches, searchCount, 'durationchange must not trigger auto search')
    }
    assert.equal(JSON.stringify(await state().get('slots')), raw)
    assert.equal(await state().get('offset'), 2)
    assert.equal((await state().get('slotDetails'))[0].offsetMs, 5000)
  } else if (mode === 'invalid') {
    await change(1425, 520)
    assert.equal((await info()).providerTimeline, undefined)
    assert.deepEqual(positions(), [497158, 1122574])
  } else if (mode === 'replace' || mode === 'replace-positive') {
    const old = selectedVideo
    selectedVideo = new Video()
    if (mode === 'replace-positive') selectedVideo.duration = 1506.372
    await patcher.setVideo(selectedVideo); await load()
    assert.equal(old.durationListeners.size, 0)
    const accepted = await info()
    await change(1506.372, 1200, old)
    assert.deepEqual(await info(), accepted)
    if (mode === 'replace-positive') assert.equal(accepted.providerTimeline, undefined)
    else assert.equal(accepted.providerTimeline.alignments.length, 1)
  } else if (mode === 'switch') {
    episode = 2; await observer.callback(); await flush()
    assert.equal((await info()).providerTimeline, undefined)
    assert.equal(selectedVideo.durationListeners.size, 0)
    await change(1506.372, 1200)
    assert.equal((await info()).providerTimeline, undefined)
    selectedVideo.duration = 1426; selectedVideo.currentTime = 0; await load()
    assert.equal((await info()).providerTimeline.alignments.length, 1)
    await change(1446.111, 433.975)
    assert.equal((await info()).providerTimeline.alignments[1].sourceTimeMs, 433975)
    assert.equal((await info()).providerTimeline.alignments[1].targetTimeMs, 454086)
  } else if (mode === 'clear') {
    await patcher.nco.clear(); await flush()
    assert.equal(await info(), null)
    assert.equal(selectedVideo.durationListeners.size, 0)
    await load('reload')
    assert.equal((await info()).providerTimeline.alignments[1].targetTimeMs, 524940)
    assert.equal(selectedVideo.durationListeners.size, 1)
  } else if (mode === 'read-race' || mode === 'write-race') {
    let release, started
    const promise = new Promise(resolve => { release = resolve })
    const entered = new Promise(resolve => { started = resolve })
    if (mode === 'read-race') blockGet = { promise }
    else blockSet = { promise, started }
    selectedVideo.duration = 1506.372; selectedVideo.currentTime = 1148.940833
    selectedVideo.dispatchEvent(new Event('durationchange'))
    await flush()
    if (mode === 'write-race') await entered
    const clearing = patcher.nco.clear()
    release(); await clearing; await flush()
    assert.equal(await info(), null, 'No dispatched/queued patch may restore cleared info')
  } else if (mode === 'late-response') {
    let release, entered
    const requested = new Promise(resolve => { entered = resolve })
    delayedReply = reply => new Promise(resolve => { release = () => resolve(reply); entered() })
    const oldLoad = patcher.nco.dispatch('reload'); await requested
    episode = 2; await observer.callback(); await flush()
    delayedReply = null; selectedVideo.duration = 1426; selectedVideo.currentTime = 0
    await load('reload')
    const accepted = await info()
    release(); await oldLoad; await flush()
    assert.deepEqual(await info(), accepted)
    assert.ok(errors.some(error => /Stale Prime/.test(error)))
  } else if (mode === 'precommit-duration') {
    const playing = await init.getInfo(patcher.nco, {})
    await change(1506.372, 1148.940833)
    await state().set('info', { ...(await info()), providerTimeline: playing.providerTimeline })
    await flush()
    assert.equal((await info()).providerTimeline.alignments[2].targetTimeMs, 1198946)
    assert.deepEqual(positions(), [529940, 1203946])
  } else if (mode === 'commit-race') {
    const request = {}
    const pending = init.getInfo(patcher.nco, request)
    const playing = await pending
    assert.ok(playing.providerTimeline)
    await patcher.nco.clear()
    assert.equal(request.isCurrent(), false)
    assert.equal(await info(), null)
  } else throw new Error('Unknown mode: ' + mode)
}
for (const [event, payload] of logs) {
  if (event === 'primeVideo.timelineSync') {
    assert.ok(!JSON.stringify(payload).includes('PRIVATE-'))
    assert.ok(!JSON.stringify(payload).includes('blob:'))
    assert.ok(!JSON.stringify(payload).includes('https:'))
  }
}
if (mode !== 'late-response') assert.deepEqual(errors, [])
const last = selectedVideo
await patcher.dispose(); await flush()
assert.equal(last.durationListeners.size, 0)
console.log('prime-runtime-pass:' + mode)
`

describe('Prime durationchange through actual runtime and renderer refresh', () => {
  for (const mode of [
    'before',
    'after',
    'invalid',
    'replace',
    'replace-positive',
    'switch',
    'reload',
    'clear',
    'read-race',
    'write-race',
    'late-response',
    'commit-race',
    'precommit-duration',
    'movie',
  ]) {
    test(mode, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', probe, mode],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(
        `prime-runtime-pass:${mode}`
      )
    })
  }
})
