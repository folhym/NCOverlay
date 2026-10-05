import { beforeEach, describe, expect, mock, test } from 'bun:test'

// Mock browser boundaries only: the state pipeline, marker detector and Core
// below are the real implementations. This fixture does not exercise playback.
const stored = new Map()
const writes = []
const settingValues = {
  'comment:speed': 1,
  'comment:customize': {},
  'comment:hideAssistedComments': false,
  'comment:adjustJikkyoOffset': false,
  'autoSearch:jikkyoOnlyAdjustable': false,
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
  logger: { log() {} },
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
