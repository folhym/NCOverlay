import { describe, expect, test } from 'bun:test'

import {
  extractPrimeTimelineEvidence,
  inspectPrimeTimeline,
} from '../../src/timeline-sync/providers/primeVideo'

// Synthetic records verify extraction, not Prime field semantics or playback.
function resource(playback = {}, transitionTimecodes = {}) {
  return {
    vodPlaylistedPlaybackUrls: { result: { playbackUrls: playback } },
    transitionTimecodes,
  }
}

function frozen(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}

describe('Prime timeline evidence without inferred mappings', () => {
  test('A/I: durations remain separate and their difference creates no timeline', () => {
    const evidence = extractPrimeTimelineEvidence(
      resource({ fullTitleDurationMs: 1440000 })
    )
    const result = inspectPrimeTimeline(evidence, 1560.5, 123.25)
    expect(evidence.fullTitleDurationMs).toBe(1440000)
    expect(result.diagnostics.mediaDurationMs).toBe(1560500)
    expect(result.diagnostics.mediaCurrentTimeMs).toBe(123250)
    expect(result.diagnostics.fullTitleDurationMs).toBe(1440000)
    expect(result.diagnostics.status).toBe('awaiting-field-verification')
    expect(result.providerTimeline).toBeUndefined()
    expect(result.diagnostics).not.toHaveProperty('alignments')
  })

  test('B/C: Main/Remote/unknown labels and original indices retain their order', () => {
    const evidence = extractPrimeTimelineEvidence(
      resource({
        intraTitlePlaylist: [
          {
            type: 'Main',
            startMs: 0,
            endMs: 600000,
            shouldShowOnScrubBar: true,
            nonLinearAds: [],
          },
          {
            type: 'Remote',
            startMs: 600000,
            endMs: 690000,
            shouldShowOnScrubBar: false,
            nonLinearAds: [{ url: 'secret-url' }, {}],
          },
          { type: 'Main', startMs: 690000, endMs: 1000000 },
          { type: 'Remote', startMs: 1000000, endMs: 1030000 },
          { type: 'Future_Type', startMs: 1030000, endMs: 1440000 },
        ],
      })
    )
    const diagnostic = inspectPrimeTimeline(evidence, 1560, 0).diagnostics
    expect(
      diagnostic.intraTitlePlaylist.map(({ index, type }) => [index, type])
    ).toEqual([
      [0, 'Main'],
      [1, 'Remote'],
      [2, 'Main'],
      [3, 'Remote'],
      [4, 'Future_Type'],
    ])
    expect(diagnostic.intraTitlePlaylist[1]).toEqual({
      index: 1,
      type: 'Remote',
      startMs: 600000,
      endMs: 690000,
      rangeStatus: 'unverified',
      shouldShowOnScrubBar: false,
      nonLinearAdsCount: 2,
    })
    expect(diagnostic.intraTitlePlaylist[0].nonLinearAdsCount).toBe(0)
    expect(diagnostic.intraTitlePlaylist[2].nonLinearAdsCount).toBeNull()
    expect(diagnostic.intraTitlePlaylist[2].shouldShowOnScrubBar).toBeNull()
  })

  test('D: opaque transition labels, event order and interval times are retained', () => {
    const evidence = extractPrimeTimelineEvidence(
      resource(
        {},
        {
          result: {
            events: [
              {
                eventType: 'X',
                startTimeMs: 57000,
                intervals: [{ startTimeMs: 57000 }, { startTimeMs: 145000 }],
              },
              {
                eventType: 'FutureEvent_2',
                startTimeMs: 600000,
                intervals: [{ startTimeMs: 600000 }],
              },
            ],
          },
        }
      )
    )
    expect(
      inspectPrimeTimeline(evidence, 1500, 0).diagnostics.transitionEvents
    ).toEqual([
      {
        index: 0,
        eventType: 'X',
        startTimeMs: 57000,
        intervalStartTimesMs: [57000, 145000],
      },
      {
        index: 1,
        eventType: 'FutureEvent_2',
        startTimeMs: 600000,
        intervalStartTimesMs: [600000],
      },
    ])
  })

  test('E/F: build only the allowlist, ignoring private metadata at every level', () => {
    const secret = 'PRIVATE-SENTINEL'
    const raw = frozen({
      ...resource(
        {
          fullTitleDurationMs: 1440000,
          title: secret,
          titleId: secret,
          entityId: secret,
          consumptionId: secret,
          intraTitlePlaylist: [
            {
              type: 'Remote',
              startMs: 1000,
              endMs: 2000,
              urls: [
                {
                  url: `https://cdn.invalid/${secret}?token=${secret}`,
                  consumptionId: secret,
                },
              ],
              urlsInPriorityOrder: [secret],
              cookie: secret,
              header: secret,
              nonLinearAds: [{ url: secret, token: secret }],
              manifestMetadata: { token: secret, title: secret },
            },
          ],
        },
        {
          result: {
            events: [
              {
                eventType: 'X',
                startTimeMs: 1000,
                title: secret,
                url: secret,
                intervals: [{ startTimeMs: 1100, id: secret, token: secret }],
              },
            ],
          },
        }
      ),
      title: secret,
      subtitle: secret,
      seriesTitle: secret,
      __metadata: { id: secret },
      sessionization: { sessionHandoffToken: secret },
    })
    const before = JSON.stringify(raw)
    const evidence = extractPrimeTimelineEvidence(raw)
    const result = inspectPrimeTimeline(evidence, 1500, 0)
    expect(JSON.stringify(evidence)).not.toContain(secret)
    expect(JSON.stringify(result)).not.toContain(secret)
    expect(Object.keys(result.diagnostics).sort()).toEqual([
      'fullTitleDurationMs',
      'intraTitlePlaylist',
      'mediaCurrentTimeMs',
      'mediaDurationMs',
      'status',
      'transitionEvents',
    ])
    expect(Object.keys(evidence.intraTitlePlaylist[0]).sort()).toEqual([
      'endMs',
      'index',
      'nonLinearAdsCount',
      'rangeStatus',
      'shouldShowOnScrubBar',
      'startMs',
      'type',
    ])
    expect(JSON.stringify(raw)).toBe(before)
  })

  test('the content boundary re-sanitizes page evidence instead of spreading it', () => {
    const secret = 'PRIVATE-CONTENT-SENTINEL'
    const evidence = {
      status: 'captured',
      fullTitleDurationMs: 1440000,
      token: secret,
      intraTitlePlaylist: [
        {
          type: 'Main',
          startMs: 0,
          endMs: 1000,
          nonLinearAdsCount: 3,
          url: secret,
          index: 999,
        },
      ],
      transitionEvents: [
        {
          eventType: 'X',
          startTimeMs: 0,
          intervalStartTimesMs: [0, { token: secret }],
          cookie: secret,
          index: 999,
        },
      ],
    }
    const diagnostic = inspectPrimeTimeline(evidence, 1500, 0).diagnostics
    expect(JSON.stringify(diagnostic)).not.toContain(secret)
    expect(diagnostic.intraTitlePlaylist[0].index).toBe(0)
    expect(diagnostic.intraTitlePlaylist[0].nonLinearAdsCount).toBe(3)
    expect(diagnostic.transitionEvents[0].index).toBe(0)
    expect(diagnostic.transitionEvents[0].intervalStartTimesMs).toEqual([
      0,
      null,
    ])
  })

  test('URL/query/header/free-text values in label fields are omitted', () => {
    for (const value of [
      'https://cdn.invalid/?token=secret',
      'token=secret',
      'Cookie: secret',
      'private title',
      'X'.repeat(65),
      {},
      null,
    ]) {
      const evidence = extractPrimeTimelineEvidence(
        resource(
          { intraTitlePlaylist: [{ type: value }] },
          { result: { events: [{ eventType: value }] } }
        )
      )
      expect(evidence.intraTitlePlaylist[0].type).toBeNull()
      expect(evidence.transitionEvents[0].eventType).toBeNull()
    }
  })

  test('G: missing/malformed resource containers and media inputs never throw', () => {
    for (const raw of [
      undefined,
      null,
      [],
      'bad',
      2,
      {},
      { transitionTimecodes: null },
      resource({}, { result: null }),
      resource({}, { result: { events: null } }),
      resource({ intraTitlePlaylist: null }),
    ]) {
      expect(() => {
        const evidence = extractPrimeTimelineEvidence(raw)
        const result = inspectPrimeTimeline(evidence, NaN, Infinity)
        expect(result.providerTimeline).toBeUndefined()
      }).not.toThrow()
    }
    const result = inspectPrimeTimeline(undefined, 1500, 0)
    expect(result.diagnostics.status).toBe('resource-unavailable')
    expect(result.diagnostics.transitionEvents).toEqual([])
  })

  test('H: invalid times are null, reverse ranges stay flagged, positions remain', () => {
    const invalids = [NaN, Infinity, -1, '1000', false, {}]
    for (const value of invalids) {
      const evidence = extractPrimeTimelineEvidence(
        resource(
          {
            fullTitleDurationMs: value,
            intraTitlePlaylist: [
              null,
              { type: 'Main', startMs: value, endMs: 20 },
              { type: 'Remote', startMs: 20, endMs: 10 },
            ],
          },
          {
            result: {
              events: [
                null,
                {
                  eventType: 'X',
                  startTimeMs: value,
                  intervals: [{ startTimeMs: value }, null],
                },
              ],
            },
          }
        )
      )
      const result = inspectPrimeTimeline(evidence, 1500, 0)
      expect(result.diagnostics.fullTitleDurationMs).toBeNull()
      expect(result.diagnostics.intraTitlePlaylist[0].rangeStatus).toBe(
        'invalid'
      )
      expect(result.diagnostics.intraTitlePlaylist[1].startMs).toBeNull()
      expect(result.diagnostics.intraTitlePlaylist[1].rangeStatus).toBe(
        'invalid'
      )
      expect(result.diagnostics.intraTitlePlaylist[2].rangeStatus).toBe(
        'invalid'
      )
      expect(result.diagnostics.intraTitlePlaylist[2].startMs).toBe(20)
      expect(result.diagnostics.intraTitlePlaylist[2].endMs).toBe(10)
      expect(result.diagnostics.transitionEvents[1].startTimeMs).toBeNull()
      expect(
        result.diagnostics.transitionEvents[1].intervalStartTimesMs
      ).toEqual([null, null])
      expect(result.providerTimeline).toBeUndefined()
    }
  })

  test('missing endpoints and intervals are unknown, not coerced to zero', () => {
    const evidence = extractPrimeTimelineEvidence(
      resource(
        {
          intraTitlePlaylist: [
            { type: 'Main' },
            { type: 'Remote', startMs: 0 },
          ],
        },
        { result: { events: [{ eventType: 'X' }] } }
      )
    )
    expect(evidence.intraTitlePlaylist[0].startMs).toBeNull()
    expect(evidence.intraTitlePlaylist[1].endMs).toBeNull()
    expect(evidence.intraTitlePlaylist[1].rangeStatus).toBe('missing')
    expect(evidence.transitionEvents[0].startTimeMs).toBeNull()
    expect(evidence.transitionEvents[0].intervalStartTimesMs).toEqual([])
  })

  test('media conversion accepts zero currentTime, rejects invalid/overflow duration', () => {
    const evidence = extractPrimeTimelineEvidence(
      resource({ fullTitleDurationMs: 1440000 })
    )
    expect(
      inspectPrimeTimeline(evidence, 1500, 0).diagnostics.mediaCurrentTimeMs
    ).toBe(0)
    for (const value of [
      0,
      -1,
      NaN,
      Infinity,
      '1500',
      null,
      Number.MAX_VALUE,
    ]) {
      const result = inspectPrimeTimeline(evidence, value, -1)
      expect(result.diagnostics.mediaDurationMs).toBeNull()
      expect(result.diagnostics.mediaCurrentTimeMs).toBeNull()
      expect(result.diagnostics.status).toBe('invalid-media-duration')
      expect(result.providerTimeline).toBeUndefined()
    }
  })
})
