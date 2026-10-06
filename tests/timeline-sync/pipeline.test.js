import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock browser/overlay boundaries: Patcher, State, marker detection and Core
// below use real implementations. This fixture does not exercise playback.
const stored = new Map()
const writes = []
const settingValues = {
  'comment:speed': 1,
  'comment:customize': {},
  'comment:hideAssistedComments': false,
  'comment:adjustJikkyoOffset': false,
  'autoSearch:jikkyoOnlyAdjustable': false,
  'autoSearch:manual': true,
  'ng:sharingLevel': 'none',
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

mock.module('../../src/utils/logger', () => ({
  logger: {
    log() {},
    error(_context, error) {
      throw error
    },
  },
}))
mock.module('../../src/utils/settings/extension', () => ({
  settings: {
    async get(...keys) {
      const values = keys.map((key) => {
        if (!(key in settingValues))
          throw new Error(`Unexpected setting: ${key}`)
        return settingValues[key]
      })
      return keys.length === 1 ? values[0] : values
    },
  },
}))
mock.module('../../src/utils/storage/extension', () => ({
  storage: {
    async get(key) {
      return stored.get(key) ?? null
    },
    async set(key, value) {
      writes.push(key)
      // A shared frozen snapshot exposes mutation of raw source threads rather
      // than silently hiding it behind another storage serialization.
      stored.set(key, deepFreeze(structuredClone(value)))
    },
    async remove(key) {
      stored.delete(key)
    },
  },
}))
mock.module('../../src/utils/api/niconico/getNgSettings', () => ({
  async getNgSettings() {
    return { words: [], commands: [], ids: [] }
  },
}))

const { NCOState } = await import('../../src/ncoverlay/state')

// Preserve the real state while capturing Patcher's event registration. The
// browser's video event dispatch, canvas and NCOverlay rendering are fixtures.
class PatcherOverlayFixture {
  constructor(id, video) {
    this.id = id
    this.video = video
    this.canvas = {}
    this.state = new NCOState(id)
    this.listeners = new Map()
  }

  addEventListener(event, callback) {
    this.listeners.set(event, callback)
  }

  async dispatch(event) {
    const callback = this.listeners.get(event)
    if (!callback) throw new Error(`Missing Patcher event: ${event}`)
    await callback.call(this)
  }

  async clear() {
    await this.state.clear()
  }

  async dispose() {
    await this.state.dispose()
  }
}

mock.module('../../src/ncoverlay/index', () => ({
  NCOverlay: PatcherOverlayFixture,
}))
mock.module('../../src/messaging/extension', () => ({
  async sendExtensionMessage(message) {
    if (message !== 'bg:getCurrentTab')
      throw new Error(`Unexpected Patcher message: ${message}`)
    return { id: 1 }
  },
}))

const { NCOPatcher } = await import('../../src/ncoverlay/patcher')

const providerTimeline = {
  anchors: [
    { key: 'aPart', timeMs: 180000 },
    { key: 'bPart', timeMs: 720000 },
  ],
  durationMs: 1500000,
}

function markerThreads() {
  return [
    {
      id: 'fixture-thread',
      fork: 'main',
      commentCount: 6,
      comments: ['A', 'B'].flatMap((body, index) =>
        Array.from({ length: 3 }, (_, markerIndex) => ({
          id: `${body}-${markerIndex}`,
          no: index * 3 + markerIndex + 1,
          body,
          vposMs: index ? 810000 : 180000,
          commands: [],
          isPremium: false,
          userId: `fixture-${markerIndex}`,
          score: 0,
        }))
      ),
    },
  ]
}

async function createState(type = 'official', timeline = providerTimeline) {
  const state = new NCOState(1)
  const id = type === 'jikkyo' ? 'jk7:0-1500000' : 'fixture-slot'
  const isAutoLoaded = type !== 'file'
  const detail = {
    id,
    status: 'ready',
    type,
    offsetMs: 5000,
    isAutoLoaded,
    skip: false,
    info: {
      id: type === 'file' ? null : id,
      source: type === 'file' || type === 'jikkyo' ? null : 'niconico',
      title: 'fixture',
      duration: type === 'file' ? null : 1500,
      date: type === 'jikkyo' ? [0, 1500000] : 0,
      tags: [],
      count: { view: 0, comment: 6 },
    },
    ...(type === 'jikkyo' ? { markers: [], chapters: [] } : {}),
  }

  await state.set('info', {
    duration: 1500,
    ...(timeline ? { providerTimeline: timeline } : {}),
  })
  await state.set('slots', [{ id, threads: markerThreads(), isAutoLoaded }])
  await state.set('slotDetails', [detail])
  await state.set('offset', 2)
  return state
}

function positions(threads, body) {
  return threads.flatMap((thread) =>
    thread.comments
      .filter((comment) => comment.body === body)
      .map((comment) => comment.vposMs)
  )
}

const directAdjustments = [3000, -6000, 3000, -6000, 3000, -6000, 3000, -6000]
const directAlignments = directAdjustments.map((adjustment, index) => ({
  sourceTimeMs: (index + 1) * 100000,
  targetTimeMs: (index + 1) * 100000 + adjustment,
  reason: `break-${index + 1}`,
}))

function ordinaryBoundaryThreads() {
  const comments = directAlignments.flatMap(({ sourceTimeMs }, index) =>
    [-1, 0, 1].map((relative, relativeIndex) => ({
      id: `boundary-${index}-${relativeIndex}`,
      no: index * 3 + relativeIndex + 1,
      body: `ordinary comment ${index}-${relativeIndex}`,
      vposMs: sourceTimeMs + relative,
      commands: [],
      isPremium: false,
      userId: 'fixture',
      score: 0,
    }))
  )

  return [{ id: 'boundary-thread', fork: 'main', commentCount: 24, comments }]
}

async function stateFromPlayingInfo(
  timeline,
  sourceThreads,
  vod = 'primeVideo'
) {
  const durationSeconds = (timeline.durationMs ?? 1000000) / 1000
  const playingInfo = deepFreeze({
    input: 'fixture',
    duration: durationSeconds,
    providerTimeline: timeline,
  })
  const getInfo = mock(async () => playingInfo)
  const appendCanvas = mock(() => {})
  const patcher = new NCOPatcher(vod, { getInfo, appendCanvas })
  const video = { currentTime: 0 }

  await patcher.setVideo(video)
  const overlay = patcher.nco
  expect(overlay.listeners.has('loadedmetadata')).toBe(true)
  expect(appendCanvas).toHaveBeenCalledWith(video, overlay.canvas)
  await overlay.dispatch('loadedmetadata')
  expect(getInfo).toHaveBeenCalledTimes(1)
  expect(getInfo).toHaveBeenCalledWith(overlay, {})
  expect((await overlay.state.get('info')).providerTimeline).toEqual(timeline)
  expect((await overlay.state.get('info')).duration).toBe(
    Math.floor(durationSeconds)
  )
  // This identifies the shared Patcher fixture; no service API adapter runs.
  expect(await overlay.state.get('vod')).toBe(vod)

  // loadedmetadata keeps the original clear semantics. Seed manual offsets
  // afterwards to test that reading the new timeline does not change them.
  await overlay.state.set('slots', [
    { id: 'runtime-slot', threads: sourceThreads, isAutoLoaded: false },
  ])
  await overlay.state.set('slotDetails', [
    { id: 'runtime-slot', type: 'official', status: 'ready', offsetMs: 5000 },
  ])
  await overlay.state.set('offset', 2)
  return { patcher, state: overlay.state }
}

beforeEach(() => {
  stored.clear()
  writes.length = 0
})

describe('state timeline pipeline with browser boundary fixtures', () => {
  test('maps raw B markers before Slot Offset and preserves Global Offset', async () => {
    const state = await createState()
    const threads = await state.getThreads()

    expect(positions(threads, 'A')).toEqual([185000, 185000, 185000])
    expect(positions(threads, 'B')).toEqual([725000, 725000, 725000])
    expect(await state.get('offset')).toBe(2)

    // Renderer uses mediaTime - Global Offset (seconds). This is its timing
    // equation, not a mocked or actual Renderer / Netflix playback assertion.
    const displayTimeMs = positions(threads, 'B')[0]
    const globalOffsetSeconds = await state.get('offset')
    expect(displayTimeMs + globalOffsetSeconds * 1000).toBe(727000)
  })

  test('repeated getThreads starts from immutable raw source without writes', async () => {
    const state = await createState()
    const rawSlots = await state.get('slots')
    const original = JSON.stringify(rawSlots)
    const writesBeforeRead = [...writes]

    const first = await state.getThreads()
    const second = await state.getThreads()

    expect(second).toEqual(first)
    expect(positions(second, 'B')).toEqual([725000, 725000, 725000])
    expect(JSON.stringify(await state.get('slots'))).toBe(original)
    expect(positions(rawSlots[0].threads, 'B')).toEqual([
      810000, 810000, 810000,
    ])
    expect(writes).toEqual(writesBeforeRead)
  })

  test('without provider input, applies only the existing Slot Offset', async () => {
    const state = await createState('official', null)
    const threads = await state.getThreads()

    expect(positions(threads, 'A')).toEqual([185000, 185000, 185000])
    expect(positions(threads, 'B')).toEqual([815000, 815000, 815000])
  })

  for (const type of ['jikkyo', 'file']) {
    test(`excludes ${type} even with matching provider anchors`, async () => {
      // Legacy Jikkyo adjustment is disabled to isolate the new source policy.
      const state = await createState(type)
      const writesBeforeRead = [...writes]
      const threads = await state.getThreads()

      expect(positions(threads, 'B')).toEqual([815000, 815000, 815000])
      expect(writes).toEqual(writesBeforeRead)
    })
  }

  test('removing episode info immediately discards its previous plan', async () => {
    const state = await createState()
    expect(positions(await state.getThreads(), 'B')).toEqual([
      725000, 725000, 725000,
    ])

    await state.remove('info')

    expect(positions(await state.getThreads(), 'B')).toEqual([
      815000, 815000, 815000,
    ])
    expect(await state.get('info')).toBeNull()
    expect(positions((await state.get('slots'))[0].threads, 'B')).toEqual([
      810000, 810000, 810000,
    ])
  })

  test('clear removes the previous episode timeline with the original state', async () => {
    const state = await createState()
    expect(positions(await state.getThreads(), 'B')).toEqual([
      725000, 725000, 725000,
    ])

    await state.clear()

    expect(await state.get('info')).toBeNull()
    expect(await state.get('offset')).toBeNull()
    expect(await state.get('slots')).toBeNull()
    expect(await state.getThreads()).toBeNull()
  })
})

describe('PlayingInfo timeline runtime binding', () => {
  test('Prime-identified Patcher copies eight arbitrary boundaries and maps ordinary comments', async () => {
    const timeline = { alignments: directAlignments, durationMs: 1000000 }
    const { patcher, state } = await stateFromPlayingInfo(
      timeline,
      ordinaryBoundaryThreads()
    )
    expect((await state.get('info')).providerTimeline.anchors).toBeUndefined()

    const rawSlots = await state.get('slots')
    const rawSnapshot = JSON.stringify(rawSlots)
    const writesBeforeRead = [...writes]
    const first = await state.getThreads()
    const second = await state.getThreads()
    const expected = directAlignments.flatMap(({ sourceTimeMs }, index) => [
      sourceTimeMs - 1 + (index ? directAdjustments[index - 1] : 0) + 5000,
      sourceTimeMs + directAdjustments[index] + 5000,
      sourceTimeMs + 1 + directAdjustments[index] + 5000,
    ])

    expect(first[0].comments.map(({ vposMs }) => vposMs)).toEqual(expected)
    expect(second).toEqual(first)
    expect(first[0].commentCount).toBe(24)
    expect(JSON.stringify(await state.get('slots'))).toBe(rawSnapshot)
    expect((await state.get('slotDetails'))[0].offsetMs).toBe(5000)
    expect(await state.get('offset')).toBe(2)
    expect(writes).toEqual(writesBeforeRead)
    // Global Offset remains a Renderer timing equation, not playback coverage.
    expect(first[0].comments.at(-2).vposMs + 2 * 1000).toBe(801000)
    await patcher.dispose()
  })

  test('Netflix-identified Patcher preserves semantic fallback without direct alignments', async () => {
    const { patcher, state } = await stateFromPlayingInfo(
      providerTimeline,
      markerThreads(),
      'netflix'
    )

    expect(
      (await state.get('info')).providerTimeline.alignments
    ).toBeUndefined()
    expect(positions(await state.getThreads(), 'B')).toEqual([
      725000, 725000, 725000,
    ])
    expect(await state.get('offset')).toBe(2)
    await patcher.dispose()
  })

  test('rejects explicitly reverse alignments without falling back to valid semantic anchors', async () => {
    const timeline = {
      ...providerTimeline,
      alignments: [...directAlignments].reverse(),
    }
    const { patcher, state } = await stateFromPlayingInfo(
      timeline,
      markerThreads()
    )

    // This source/provider anchor pair normally maps B to 725000. Explicit
    // invalid direct evidence must instead preserve raw B + Slot Offset.
    expect(positions(await state.getThreads(), 'B')).toEqual([
      815000, 815000, 815000,
    ])
    expect(await state.get('offset')).toBe(2)
    await patcher.dispose()
  })
})
