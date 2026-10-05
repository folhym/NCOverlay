import { describe, expect, test } from 'bun:test'

// Each probe imports the actual Netflix entrypoint, Patcher, State and Core.
// Browser IO and NCOverlay's canvas/event shell are fixtures in an isolated
// process. Synthetic metadata does not establish Netflix marker semantics,
// field units, or real browser/API/playback behavior.
const netflixProbe = String.raw`
import assert from 'node:assert/strict'
import { mock } from 'bun:test'

const mode = process.argv[1]
const stored = new Map()
const writes = []
const logs = []
const errors = []
const requests = []
const queuedRequests = []
const requestWaiters = []
let observer
let capturePatcher
const captured = new Promise(resolve => { capturePatcher = resolve })
let clock = 0
const settingsValues = {
  'comment:speed': 1, 'comment:customize': {},
  'comment:hideAssistedComments': false, 'comment:adjustJikkyoOffset': false,
  'autoSearch:jikkyoOnlyAdjustable': false, 'ng:sharingLevel': 'none',
  'autoSearch:manual': true, 'autoSearch:targets': [],
  'autoSearch:jikkyoChannelIds': [], 'autoSearch:jikkyoIgnoreRerun': false,
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

mock.module('@/utils/logger', () => ({ logger: {
  log(...args) { logs.push(args) },
  error(_context, error) { errors.push(error?.message ?? String(error)) },
} }))
mock.module('@/utils/settings/extension', () => ({ settings: {
  async get(...keys) {
    const values = keys.map(key => {
      assert.ok(key in settingsValues, 'Unexpected setting: ' + key)
      return settingsValues[key]
    })
    return keys.length === 1 ? values[0] : values
  },
} }))
mock.module('@/utils/storage/extension', () => ({ storage: {
  async get(key) { return stored.get(key) ?? null },
  async set(key, value) {
    writes.push([key, structuredClone(value)])
    stored.set(key, deepFreeze(structuredClone(value)))
  },
  async remove(key) { stored.delete(key) },
} }))
mock.module('@/utils/api/niconico/getNgSettings', () => ({
  async getNgSettings() { return { words: [], commands: [], ids: [] } },
}))
mock.module('@/messaging/extension', () => ({
  async sendExtensionMessage(message) {
    assert.equal(message, 'bg:getCurrentTab')
    return { id: 1 }
  },
}))

const { NCOState } = await import('./src/ncoverlay/state.ts')
class OverlayFixture {
  constructor(id, video) {
    this.id = id; this.video = video; this.canvas = {}
    this.state = new NCOState(id)
    this.listeners = new Map()
  }
  addEventListener(event, callback) {
    if (!this.listeners.has(event)) this.listeners.set(event, [])
    this.listeners.get(event).push(callback)
  }
  async dispatch(event) {
    const callbacks = this.listeners.get(event)
    assert.ok(callbacks?.length, 'Missing actual Patcher listener: ' + event)
    for (const callback of callbacks) await callback.call(this)
  }
  async clear() { await this.state.clear() }
  async dispose() { await this.state.dispose(); this.listeners.clear() }
}
mock.module('@/ncoverlay/index', () => ({ NCOverlay: OverlayFixture }))

// Capture a constructor used by the entrypoint while retaining the real class.
const { NCOPatcher: RealPatcher } = await import('./src/ncoverlay/patcher.ts')
class CapturingPatcher extends RealPatcher {
  constructor(...args) { super(...args); capturePatcher(this) }
}
mock.module('@/ncoverlay/patcher', () => ({ NCOPatcher: CapturingPatcher }))
mock.module('#imports', () => ({ defineContentScript: config => config }))
mock.module('@/utils/extension/checkVodEnable', () => ({
  async checkVodEnable() { return true },
}))
mock.module('@/proxy/nco-utils/api/extension', () => ({ ncoApiProxy: {
  netflix: {
    metadata(id) {
      return new Promise(resolve => {
        const request = { id: Number(id), resolve }
        requests.push(request)
        if (requestWaiters.length) requestWaiters.shift()(request)
        else queuedRequests.push(request)
      })
    },
  },
} }))

function nextRequest() {
  if (queuedRequests.length) return Promise.resolve(queuedRequests.shift())
  return new Promise(resolve => requestWaiters.push(resolve))
}
function video(duration = 1500.5) {
  return {
    duration, currentTime: 0, src: 'blob:synthetic-playback',
    checkVisibility() { return true }, insertAdjacentElement() {},
  }
}
let selectedVideo = video()
globalThis.location = { pathname: '/watch/201' }
globalThis.performance = { now: () => { clock += 2000; return clock } }
globalThis.document = { body: { querySelector() { return selectedVideo } } }
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; observer = this }
  observe() {} disconnect() {}
}

const { default: contentScript } = await import('./src/entrypoints/vod-netflix.content/index.ts')
contentScript.main()
const patcher = await captured
assert.ok(observer, 'Entrypoint observer must be installed')
await patcher.setVideo(selectedVideo)

function episodeMetadata() {
  return deepFreeze({
    id: 100, type: 'show', title: 'Synthetic Series', runtime: 3600,
    currentEpisode: 202,
    skipMarkers: { credit: { start: 1, end: 2 } },
    seasons: [{
      id: 101, title: 'Synthetic Season', episodes: [
        { id: 201, episodeId: 202, title: 'Episode A', seq: 1, runtime: 1500,
          creditsOffset: 1400,
          skipMarkers: { credit: { start: 100, end: 150 }, recap: { start: 0, end: 12 } } },
        { id: 202, episodeId: 201, title: 'Episode B', seq: 2, runtime: 1600,
          skipMarkers: { credit: { start: 200, end: 250 } } },
      ],
    }],
  })
}
function movieMetadata(withOptionalFields = true) {
  return deepFreeze({
    id: 201, type: 'movie', title: 'Synthetic Movie',
    ...(withOptionalFields ? {
      runtime: 1400, creditsOffset: 1300,
      skipMarkers: { credit: { start: 15, end: 85 }, recap: { start: null, end: null } },
    } : {}),
  })
}
async function startLoad(overlay = patcher.nco, event = 'loadedmetadata') {
  const pending = overlay.dispatch(event)
  const request = await nextRequest()
  return { pending, request }
}
async function completeLoad(metadata) {
  const { pending, request } = await startLoad()
  request.resolve(metadata)
  await pending
}
function infoInput(info) {
  return typeof info?.input === 'string' ? info.input : info?.input?.input ?? ''
}
function infoWrites() {
  return writes.filter(([key]) => key === 'state:1:info').map(([, value]) => value)
}
function diagnostics() {
  return logs.filter(([event]) => event === 'netflix.providerTimeline')
    .map(([, value]) => {
      assert.equal(value.providerTimeline, null)
      return value.diagnostics
    })
}
function markerThreads() {
  return [{ id: 'fixture-thread', fork: 'main', commentCount: 6,
    comments: ['A', 'B'].flatMap((body, index) =>
      Array.from({ length: 3 }, (_, count) => ({
        id: body + count, body, vposMs: index ? 810000 : 180000,
        commands: [], isPremium: false, userId: 'fixture', score: 0,
      }))
    ),
  }]
}
async function seedManualOffsets(state) {
  await state.set('slots', [{ id: 'fixture-slot', threads: markerThreads(), isAutoLoaded: false }])
  await state.set('slotDetails', [{ id: 'fixture-slot', type: 'official', status: 'ready', offsetMs: 5000, isAutoLoaded: false }])
  await state.set('offset', 2)
}
async function assertUncorrectedPipeline(state) {
  const raw = JSON.stringify(await state.get('slots'))
  const initialWrites = writes.length
  const first = await state.getThreads()
  const second = await state.getThreads()
  const bPositions = first.flatMap(thread => thread.comments).filter(comment => comment.body === 'B').map(comment => comment.vposMs)
  assert.deepEqual(bPositions, [815000, 815000, 815000])
  assert.deepEqual(second, first)
  assert.equal(JSON.stringify(await state.get('slots')), raw)
  assert.equal(await state.get('offset'), 2)
  assert.equal((await state.get('slotDetails'))[0].offsetMs, 5000)
  assert.equal(writes.length, initialWrites)
  assert.equal(bPositions[0] + (await state.get('offset')) * 1000, 817000)
}

if (['commit-route', 'commit-clear', 'commit-null'].includes(mode)) {
  const { pending, request } = await startLoad()
  request.resolve(mode === 'commit-null' ? null : episodeMetadata())
  // Metadata continuation runs first, then this invalidation, then Patcher's
  // continuation. Check the result again at the actual state commit boundary.
  let invalidation
  queueMicrotask(() => {
    if (mode === 'commit-clear') invalidation = patcher.nco.clear()
    else {
      globalThis.location.pathname = '/watch/202'
      invalidation = observer.callback()
    }
  })
  await pending
  await invalidation
  assert.deepEqual(infoWrites(), [])
  assert.equal(await patcher.nco.state.get('info'), null)
  assert.deepEqual(errors, [])
} else if (['episode', 'movie', 'missing', 'null'].includes(mode)) {
  const metadata = mode === 'episode' ? episodeMetadata()
    : mode === 'null' ? null : movieMetadata(mode !== 'missing')
  await completeLoad(metadata)
  const info = await patcher.nco.state.get('info')
  assert.equal(info.providerTimeline, undefined)
  assert.equal(info.duration, mode === 'movie' ? 1390 : mode === 'null' ? 0 : 1490)
  if (mode === 'episode') {
    assert.ok(infoInput(info).includes('Episode A'))
    assert.ok(!infoInput(info).includes('Episode B'))
  }
  if (mode !== 'null') {
    const diagnostic = diagnostics().at(-1)
    assert.ok(diagnostic, 'Actual entrypoint must log safe timeline diagnostics')
    assert.equal(diagnostic.mediaDurationMs, 1500500)
    assert.equal(diagnostic.fields.runtimeRaw, mode === 'missing' ? null : mode === 'movie' ? 1400 : 1500)
  }
  await seedManualOffsets(patcher.nco.state)
  await assertUncorrectedPipeline(patcher.nco.state)
  assert.deepEqual(errors, [])
} else if (mode === 'invalidate') {
  await completeLoad(episodeMetadata())
  const state = patcher.nco.state
  await seedManualOffsets(state)
  const accepted = await state.get('info')
  // A confirmed Phase 2A state sentinel tests legacy cleanup only. It does not
  // assert that synthetic Netflix metadata establishes any marker semantics.
  await state.set('info', { ...accepted, providerTimeline: { anchors: [
    { key: 'aPart', timeMs: 180000 }, { key: 'bPart', timeMs: 720000 },
  ], durationMs: 1500500 } })
  const mapped = (await state.getThreads()).flatMap(thread => thread.comments)
    .filter(comment => comment.body === 'B').map(comment => comment.vposMs)
  assert.deepEqual(mapped, [725000, 725000, 725000])
  globalThis.location.pathname = '/watch/202'; await observer.callback()
  assert.equal(await state.get('info'), null)
  await assertUncorrectedPipeline(state)
  assert.deepEqual(errors, [])
} else if (mode === 'reverse' || mode === 'switch') {
  const firstOverlay = patcher.nco
  const first = await startLoad(firstOverlay)
  globalThis.location.pathname = '/watch/202'
  if (mode === 'switch') {
    selectedVideo = video(1700)
    await patcher.setVideo(selectedVideo)
    assert.notEqual(patcher.nco, firstOverlay)
  }
  const second = await startLoad()
  assert.equal(first.request.id, 201)
  assert.equal(second.request.id, 202)
  second.request.resolve(episodeMetadata()); await second.pending
  const accepted = await patcher.nco.state.get('info')
  assert.ok(infoInput(accepted).includes('Episode B'))
  first.request.resolve(episodeMetadata()); await first.pending
  assert.deepEqual(await patcher.nco.state.get('info'), accepted)
  assert.ok(infoWrites().every(info => !infoInput(info).includes('Episode A')))
  assert.ok(errors.some(message => /stale/i.test(message)))
} else if (mode === 'aba' || mode === 'clear') {
  const { pending, request } = await startLoad()
  if (mode === 'aba') {
    globalThis.location.pathname = '/watch/202'; await observer.callback()
    globalThis.location.pathname = '/watch/201'; await observer.callback()
  } else {
    await patcher.nco.clear()
  }
  request.resolve(episodeMetadata()); await pending
  assert.equal(await patcher.nco.state.get('info'), null)
  assert.deepEqual(infoWrites(), [])
  assert.ok(errors.some(message => /stale/i.test(message)))
} else if (mode === 'reload') {
  await completeLoad(episodeMetadata())
  await seedManualOffsets(patcher.nco.state)
  selectedVideo.duration = 1510
  const { pending, request } = await startLoad(patcher.nco, 'reload')
  request.resolve(episodeMetadata()); await pending
  assert.equal((await patcher.nco.state.get('info')).providerTimeline, undefined)
  assert.equal((await patcher.nco.state.get('info')).duration, 1490)
  assert.equal(diagnostics().at(-1).mediaDurationMs, 1510000)
  await assertUncorrectedPipeline(patcher.nco.state)
  assert.deepEqual(errors, [])
} else {
  throw new Error('Unknown Netflix pipeline fixture: ' + mode)
}

await patcher.dispose()
console.log('netflix-pipeline-pass:' + mode)
`

const cases = [
  [
    'commit-route',
    'route change between getInfo resolution and state commit is rejected',
  ],
  [
    'commit-clear',
    'clear between getInfo resolution and state commit is rejected',
  ],
  [
    'commit-null',
    'a null result invalidated before state commit is also rejected',
  ],
  [
    'episode',
    'exact episode uses its metadata while unresolved anchors pass through',
  ],
  [
    'movie',
    'movie metadata passes through without invented OP or ED boundaries',
  ],
  [
    'missing',
    'missing optional fields use video duration only for search fallback',
  ],
  [
    'null',
    'missing metadata safely leaves the original display pipeline usable',
  ],
  [
    'reverse',
    'a late episode A response cannot overwrite accepted episode B info',
  ],
  [
    'invalidate',
    'URL switch removes accepted timeline info while preserving manual offsets',
  ],
  [
    'switch',
    'an old video response cannot overwrite the replacement overlay info',
  ],
  ['aba', 'an A to B to A route change invalidates the first A request'],
  [
    'clear',
    'clear prevents a pending response from restoring previous episode info',
  ],
  [
    'reload',
    'same episode reload preserves manual offsets and rereads media duration',
  ],
]

describe('actual Netflix entrypoint through Patcher and state fixtures', () => {
  for (const [mode, name] of cases) {
    test(name, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', netflixProbe, mode],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(
        `netflix-pipeline-pass:${mode}`
      )
    })
  }
})
