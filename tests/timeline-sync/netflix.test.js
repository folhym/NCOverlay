import { describe, expect, test } from 'bun:test'

import { createCommentTimelinePlan } from '../../src/timeline-sync/commentTimeline'
import { mapTimelineTime } from '../../src/timeline-sync/core'
import {
  inspectNetflixTimeline,
  selectNetflixTimelineSource,
} from '../../src/timeline-sync/providers/netflix'

// All metadata fixtures are synthetic, with two user-reported boundary pairs
// retained as regression values. The credit -> OP/A contract comes from the
// user's two live episode checks; these tests do not prove browser/API behavior.
const watchId = 800001

function movie(overrides = {}) {
  return {
    id: watchId,
    type: 'movie',
    title: 'synthetic-title',
    runtime: 1500,
    creditsOffset: 1400,
    skipMarkers: {
      credit: { start: 57057, end: 144978 },
      recap: { start: 0, end: 12 },
    },
    ...overrides,
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function expectNonnegativeFiniteOrNull(value) {
  expect(value === null || (Number.isFinite(value) && value >= 0)).toBe(true)
}

function markerThreads(markers) {
  return [
    {
      comments: [
        ...markers.flatMap(([body, vposMs]) =>
          Array.from({ length: 3 }, () => ({ body, vposMs }))
        ),
        // The existing OP detector bounds its search using the last comment.
        { body: 'synthetic-tail', vposMs: 1500000 },
      ],
    },
  ]
}

describe('Netflix source selection with synthetic metadata', () => {
  test('selects the exact Episode.id rather than currentEpisode or episodeId', () => {
    const first = { ...movie(), id: watchId - 1, episodeId: watchId }
    const selected = { ...movie(), episodeId: watchId + 1 }
    const season = {
      id: 700001,
      title: 'synthetic-season',
      episodes: [first, selected],
    }
    const metadata = {
      id: 700000,
      title: 'synthetic-series',
      currentEpisode: first.id,
      seasons: [season],
    }

    const result = selectNetflixTimelineSource(metadata, watchId)

    expect(result?.source).toBe(selected)
    expect(result?.episode).toBe(selected)
    expect(result?.season).toBe(season)
    expect(selectNetflixTimelineSource(metadata, watchId + 1)).toBeNull()
  })

  test('accepts standalone metadata only when its own id matches the watch id', () => {
    const source = movie()
    const selected = selectNetflixTimelineSource(source, watchId)
    expect(selected?.source).toBe(source)
    expect(selected?.episode).toBeUndefined()
    expect(selected?.season).toBeUndefined()
    expect(selectNetflixTimelineSource(source, watchId + 1)).toBeNull()
  })

  test('does not fall back to root metadata for an unmatched episode', () => {
    const metadata = {
      ...movie(),
      currentEpisode: watchId,
      seasons: [
        {
          title: 'synthetic-season',
          episodes: [{ id: watchId + 1, title: 'synthetic-other-episode' }],
        },
      ],
    }
    expect(selectNetflixTimelineSource(metadata, watchId)).toBeNull()
    expect(
      selectNetflixTimelineSource({ ...movie(), seasons: [] }, watchId)
    ).toBeNull()
  })

  test('missing or malformed metadata/season collections fail safely', () => {
    for (const metadata of [
      null,
      undefined,
      {},
      [],
      'invalid',
      { ...movie(), seasons: null },
      { ...movie(), seasons: {} },
      { ...movie(), seasons: [null] },
      { ...movie(), seasons: [{ episodes: null }] },
      { ...movie(), seasons: [{ episodes: {} }] },
      { ...movie(), seasons: [{ episodes: [null] }] },
    ]) {
      expect(() => selectNetflixTimelineSource(metadata, watchId)).not.toThrow()
      expect(selectNetflixTimelineSource(metadata, watchId)).toBeNull()
    }
  })

  test('requires title strings before returning values consumed by getInfo', () => {
    for (const metadata of [
      movie({ title: undefined }),
      movie({ title: null }),
      movie({ seasons: [{ episodes: [movie()] }] }),
      movie({
        seasons: [
          {
            title: 'synthetic-season',
            episodes: [movie({ title: undefined })],
          },
        ],
      }),
    ]) {
      expect(selectNetflixTimelineSource(metadata, watchId)).toBeNull()
    }
  })
})

describe('Netflix confirmed credit inspection with synthetic metadata', () => {
  test('A: credit creates OP/A anchors in ms while recap stays unverified', () => {
    const result = inspectNetflixTimeline(movie(), watchId, 1500)

    expect(result.providerTimeline).toEqual({
      anchors: [
        { key: 'op', timeMs: 57057 },
        { key: 'aPart', timeMs: 144978 },
      ],
      durationMs: 1500000,
    })
    expect(result.diagnostics.status).toBe('ready')
    expect(result.diagnostics.fields.credit).toEqual({
      status: 'confirmed',
      startRaw: 57057,
      endRaw: 144978,
    })
    expect(result.diagnostics.fields.recap).toEqual({
      status: 'unverified',
      startRaw: 0,
      endRaw: 12,
    })
  })

  test('B: an intro-named range is not treated as an OP anchor', () => {
    const source = movie({
      skipMarkers: {
        recap: { start: 0, end: 12 },
        intro: { start: 20, end: 100 },
      },
    })
    const result = inspectNetflixTimeline(source, watchId, 1500)
    expect(result.providerTimeline).toBeUndefined()
    expect(result.diagnostics.status).toBe('credit-unavailable')
    expect(result.diagnostics.fields.intro).toEqual({
      status: 'unverified',
      startRaw: 20,
      endRaw: 100,
    })
  })

  test('C: media duration alone converts seconds to ms without the search -10', () => {
    const result = inspectNetflixTimeline(movie(), watchId, 1560.5)

    expect(result.diagnostics.mediaDurationMs).toBe(1560500)
    expect(result.diagnostics.fields.runtimeRaw).toBe(1500)
    expect(result.diagnostics.fields.creditsOffsetRaw).toBe(1400)
    expect(result.providerTimeline.durationMs).toBe(1560500)
  })

  test('user-reported episode boundary pairs are retained without multiplying', () => {
    for (const [start, end] of [
      [57057, 144978],
      [139013, 226976],
    ]) {
      const result = inspectNetflixTimeline(
        movie({ skipMarkers: { credit: { start, end } } }),
        watchId,
        1500
      )
      expect(result.providerTimeline.anchors).toEqual([
        { key: 'op', timeMs: start },
        { key: 'aPart', timeMs: end },
      ])
      expect(result.diagnostics.fields.credit).toEqual({
        status: 'confirmed',
        startRaw: start,
        endRaw: end,
      })
    }
  })

  test('creditsOffset, recap or intro alone cannot create provider anchors', () => {
    for (const source of [
      movie({ skipMarkers: undefined }),
      movie({ skipMarkers: { recap: { start: 0, end: 12000 } } }),
      movie({ skipMarkers: { intro: { start: 15000, end: 85000 } } }),
    ]) {
      const result = inspectNetflixTimeline(source, watchId, 1500)
      expect(result.diagnostics.status).toBe('credit-unavailable')
      expect(result.providerTimeline).toBeUndefined()
      expect(result.diagnostics.fields.credit.status).toBe('missing')
    }
  })

  test('D: absent or null optional raw fields are missing rather than zero', () => {
    for (const source of [
      { id: watchId },
      movie({ runtime: null, creditsOffset: null, skipMarkers: null }),
      movie({
        runtime: undefined,
        creditsOffset: undefined,
        skipMarkers: {
          credit: { start: null, end: null },
          recap: { start: null, end: null },
          intro: { start: null, end: null },
        },
      }),
    ]) {
      const result = inspectNetflixTimeline(source, watchId, 1500)
      expect(result.providerTimeline).toBeUndefined()
      expect(result.diagnostics.status).toBe('credit-unavailable')
      expect(result.diagnostics.fields.runtimeRaw).toBeNull()
      expect(result.diagnostics.fields.creditsOffsetRaw).toBeNull()
      for (const name of ['credit', 'recap', 'intro']) {
        expect(result.diagnostics.fields[name]).toEqual({
          status: 'missing',
          startRaw: null,
          endRaw: null,
        })
      }
    }
  })

  test('E: invalid range numbers or ordering cannot become usable anchors', () => {
    for (const range of [
      { start: -1, end: 10 },
      { start: 10, end: -1 },
      { start: NaN, end: 10 },
      { start: 0, end: Infinity },
      { start: 20, end: 10 },
      { start: 10, end: 10 },
      { start: '0', end: 10 },
      { start: 0, end: '10' },
      false,
      [],
    ]) {
      const source = movie({ skipMarkers: { credit: range, recap: range } })
      expect(() => inspectNetflixTimeline(source, watchId, 1500)).not.toThrow()
      const result = inspectNetflixTimeline(source, watchId, 1500)
      expect(result.providerTimeline).toBeUndefined()
      expect(result.diagnostics.status).toBe('credit-unavailable')
      for (const name of ['credit', 'recap']) {
        const field = result.diagnostics.fields[name]
        expect(field.status).toBe('invalid')
        expectNonnegativeFiniteOrNull(field.startRaw)
        expectNonnegativeFiniteOrNull(field.endRaw)
      }
    }
  })

  test('invalid unrelated fields do not block valid credit anchors or get coerced', () => {
    for (const value of [-1, NaN, Infinity, -Infinity, '1500', false, {}]) {
      const result = inspectNetflixTimeline(
        movie({
          runtime: value,
          creditsOffset: value,
          skipMarkers: {
            credit: { start: 57057, end: 144978 },
            recap: value,
            intro: value,
          },
        }),
        watchId,
        1500
      )
      expect(result.diagnostics.fields.runtimeRaw).toBeNull()
      expect(result.diagnostics.fields.creditsOffsetRaw).toBeNull()
      expect(result.diagnostics.status).toBe('ready')
      expect(result.providerTimeline.anchors).toEqual([
        { key: 'op', timeMs: 57057 },
        { key: 'aPart', timeMs: 144978 },
      ])
    }
  })

  test('credit must end within media duration, including its exact endpoint', () => {
    const atEnd = inspectNetflixTimeline(
      movie({ skipMarkers: { credit: { start: 0, end: 1500000 } } }),
      watchId,
      1500
    )
    expect(atEnd.diagnostics.status).toBe('ready')
    expect(atEnd.providerTimeline.anchors).toEqual([
      { key: 'op', timeMs: 0 },
      { key: 'aPart', timeMs: 1500000 },
    ])

    for (const credit of [
      { start: 0, end: 1500001 },
      { start: 1500001, end: 1500002 },
    ]) {
      const result = inspectNetflixTimeline(
        movie({ skipMarkers: { credit } }),
        watchId,
        1500
      )
      expect(result.providerTimeline).toBeUndefined()
      expect(result.diagnostics.status).toBe('credit-unavailable')
      expect(result.diagnostics.fields.credit.status).toBe('invalid')
    }
  })

  test('a partially missing range preserves only its present numeric endpoint', () => {
    for (const [range, startRaw, endRaw] of [
      [{ start: null, end: 10 }, null, 10],
      [{ start: 0, end: null }, 0, null],
      [{ end: 10 }, null, 10],
      [{ start: 0 }, 0, null],
    ]) {
      const result = inspectNetflixTimeline(
        movie({ skipMarkers: { credit: range } }),
        watchId,
        1500
      )
      expect(result.diagnostics.fields.credit).toEqual({
        status: 'missing',
        startRaw,
        endRaw,
      })
      expect(result.providerTimeline).toBeUndefined()
      expect(result.diagnostics.status).toBe('credit-unavailable')
    }
  })

  test('invalid media duration never yields a non-finite duration or a timeline', () => {
    for (const duration of [
      undefined,
      null,
      0,
      -1,
      NaN,
      Infinity,
      '1500',
      Number.MAX_VALUE,
    ]) {
      const result = inspectNetflixTimeline(movie(), watchId, duration)
      expect(result.diagnostics.status).toBe('invalid-media-duration')
      expect(result.diagnostics.mediaDurationMs).toBeNull()
      expect(result.providerTimeline).toBeUndefined()
    }
  })

  test('mismatched content identity is reported without generating a timeline', () => {
    const result = inspectNetflixTimeline(movie(), watchId + 1, 1500)
    expect(result.diagnostics.status).toBe('content-id-mismatch')
    expect(result.providerTimeline).toBeUndefined()
  })

  test('F: OP/A source markers map through the Core for official and dAnime', () => {
    const result = inspectNetflixTimeline(movie(), watchId, 1500)
    const threads = markerThreads([
      ['OP', 100000],
      ['A', 200000],
    ])
    for (const type of ['official', 'danime', 'chapter']) {
      const plan = createCommentTimelinePlan(
        threads,
        { type },
        result.providerTimeline
      )
      expect(plan.status).toBe('mapped')
      expect(mapTimelineTime(99999, plan)).toBe(99999)
      expect(mapTimelineTime(100000, plan)).toBe(57057)
      expect(mapTimelineTime(200000, plan)).toBe(144978)
      expect(mapTimelineTime(300000, plan)).toBe(244978)
    }
  })

  test('OP-only, A-only and A/B-only source evidence remains uncorrected', () => {
    const result = inspectNetflixTimeline(movie(), watchId, 1500)
    for (const markers of [
      [['OP', 100000]],
      [['A', 200000]],
      [
        ['A', 180000],
        ['B', 810000],
      ],
    ]) {
      for (const type of ['official', 'danime']) {
        const plan = createCommentTimelinePlan(
          markerThreads(markers),
          { type },
          result.providerTimeline
        )
        expect(plan.status).toBe('unavailable')
        expect(plan.segments).toEqual([])
        expect(mapTimelineTime(810000, plan)).toBe(810000)
      }
    }
  })

  test('confirmed credit does not enable broadcast, normal or file sources', () => {
    const result = inspectNetflixTimeline(movie(), watchId, 1500)
    const threads = markerThreads([
      ['OP', 100000],
      ['A', 200000],
    ])
    for (const type of ['jikkyo', 'nicolog', 'szbh', 'normal', 'file']) {
      const plan = createCommentTimelinePlan(
        threads,
        { type },
        result.providerTimeline
      )
      expect(plan.status).toBe('unavailable')
      expect(mapTimelineTime(200000, plan)).toBe(200000)
    }
  })

  test('diagnostics contain only the declared status/numeric allowlist', () => {
    const source = movie({
      title: 'synthetic-secret-title',
      synopsis: 'synthetic-secret-synopsis',
      cookies: 'synthetic-secret-cookie',
      bookmark: { offset: 321, watchedDate: 123456 },
      skipMarkers: {
        credit: { start: 15, end: 85, title: 'synthetic-secret-marker' },
        recap: { start: null, end: null },
      },
    })
    const result = inspectNetflixTimeline(source, watchId, 1500)
    const { diagnostics } = result

    expect(Object.keys(diagnostics).sort()).toEqual([
      'fields',
      'mediaDurationMs',
      'status',
    ])
    expect(Object.keys(diagnostics.fields).sort()).toEqual([
      'credit',
      'creditsOffsetRaw',
      'intro',
      'recap',
      'runtimeRaw',
    ])
    for (const name of ['credit', 'recap', 'intro']) {
      expect(Object.keys(diagnostics.fields[name]).sort()).toEqual([
        'endRaw',
        'startRaw',
        'status',
      ])
    }
    expect(JSON.stringify(diagnostics)).not.toContain('synthetic-secret')
    expect(JSON.stringify(diagnostics)).not.toContain('bookmark')
    expect(JSON.stringify(diagnostics)).not.toContain('watchedDate')
  })

  test('source selection and inspection do not mutate the input snapshot', () => {
    const source = deepFreeze(movie())
    const metadata = deepFreeze({
      id: 700000,
      title: 'synthetic-series',
      seasons: [{ id: 700001, title: 'synthetic-season', episodes: [source] }],
    })
    const before = JSON.stringify(metadata)
    const selected = selectNetflixTimelineSource(metadata, watchId)
    inspectNetflixTimeline(selected.source, watchId, 1500)

    expect(JSON.stringify(metadata)).toBe(before)
  })
})
