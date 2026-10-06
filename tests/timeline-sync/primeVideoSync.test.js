import { describe, expect, test } from 'bun:test'

import {
  createTimelinePlanFromAlignments,
  mapTimelineTime,
} from '../../src/timeline-sync/core'
import { extractPrimeTimelineEvidence } from '../../src/timeline-sync/providers/primeVideo'
import {
  PrimeDurationTracker,
  findPrimeAdBreaks,
} from '../../src/timeline-sync/providers/primeVideoSync'

// Numbers reproduce user observations; synthetic tests are not live playback.
function evidence(times = [492158, 1117574], duration = 1425000) {
  const ends = [...times, duration]
  const entries = ends.flatMap((end, index) => [
    ...(index ? [{ type: 'Remote' }] : []),
    { type: 'Main', startMs: index ? ends[index - 1] : 0, endMs: end },
  ])
  return extractPrimeTimelineEvidence({
    vodPlaylistedPlaybackUrls: {
      result: {
        playbackUrls: {
          fullTitleDurationMs: duration,
          intraTitlePlaylist: entries,
        },
      },
    },
  })
}
function tracker(source = evidence()) {
  return new PrimeDurationTracker(findPrimeAdBreaks(source))
}
function mapped(sample, sourceTime) {
  return mapTimelineTime(
    sourceTime,
    createTimelinePlanFromAlignments(
      sample.providerTimeline?.alignments ?? [],
      sample.providerTimeline?.durationMs
    )
  )
}

describe('Prime Main/Remote content boundaries', () => {
  test('A/B: one and multiple equal Main boundaries, including observed episode A', () => {
    expect(findPrimeAdBreaks(evidence([492158])).sourceTimesMs).toEqual([
      492158,
    ])
    expect(findPrimeAdBreaks(evidence([433975, 846095], 1426000))).toEqual({
      fullTitleDurationMs: 1426000,
      sourceTimesMs: [433975, 846095],
    })
  })
  test('consecutive Remotes form one break without using their duration or URLs', () => {
    const source = evidence([492158])
    source.intraTitlePlaylist.splice(2, 0, { ...source.intraTitlePlaylist[1] })
    expect(findPrimeAdBreaks(source).sourceTimesMs).toEqual([492158])
  })
  test('C/D: mismatched, missing, negative, reverse and unknown entries fail closed', () => {
    for (const patch of [
      { startMs: 492159 },
      { startMs: null },
      { startMs: NaN },
      { startMs: -1 },
      { endMs: 492157 },
      { type: 'Unknown' },
    ]) {
      const source = evidence()
      Object.assign(source.intraTitlePlaylist[2], patch)
      expect(findPrimeAdBreaks(source)).toBeNull()
    }
    for (const entry of [null, { type: 'Remote', rangeStatus: 'invalid' }]) {
      const source = evidence()
      source.intraTitlePlaylist[1] = entry
      expect(findPrimeAdBreaks(source)).toBeNull()
    }
  })
  test('missing duration, incomplete coverage, duplicate boundaries and untrusted payload fail closed', () => {
    for (const patch of [
      (source) => {
        source.fullTitleDurationMs = Infinity
      },
      (source) => {
        source.intraTitlePlaylist[0].startMs = 1
      },
      (source) => {
        source.intraTitlePlaylist.at(-1).endMs--
      },
      (source) => {
        source.intraTitlePlaylist[2].endMs = 492158
      },
      (source) => {
        source.status = 'unavailable'
      },
    ]) {
      const source = evidence()
      patch(source)
      expect(findPrimeAdBreaks(source)).toBeNull()
    }
    expect(findPrimeAdBreaks(null)).toBeNull()
  })
})

describe('Prime dynamic media duration alignments', () => {
  test('E: baseline duration produces only identity start and leaves comment times alone', () => {
    const result = tracker().sample(1425, 0)
    expect(result.providerTimeline).toEqual({
      durationMs: 1425000,
      alignments: [{ sourceTimeMs: 0, targetTimeMs: 0, reason: 'prime:start' }],
    })
    expect(mapped(result, 1117574)).toBe(1117574)
  })
  test('F/G/O: observed before/after positions give identical cumulative mappings, independent of watching ads', () => {
    for (const [first, second] of [
      [490.876409, 1148.940833],
      [526.13374, 1200.543033],
    ]) {
      const session = tracker()
      session.sample(1425, 0)
      const one = session.sample(1457.782, first)
      expect(one.diagnostics.cumulativeInsertionMs).toBe(32782)
      expect(mapped(one, 492157)).toBe(492157)
      expect(mapped(one, 492158)).toBe(524940)
      const two = session.sample(1506.372, second)
      expect(two.diagnostics.cumulativeInsertionMs).toBe(81372)
      expect(two.diagnostics.confirmedBreakCount).toBe(2)
      expect(two.providerTimeline.alignments.at(-1)).toEqual({
        sourceTimeMs: 1117574,
        targetTimeMs: 1198946,
        reason: 'prime:ad-break',
      })
      expect(mapped(two, 1117574)).toBe(1198946)
      expect(mapped(two, 492158)).toBe(524940)
    }
  })
  test('H: varying lengths use actual duration deltas, not fixed ad seconds', () => {
    const session = tracker()
    session.sample(1425, 0)
    const one = session.sample(1432.123, 492.158)
    const two = session.sample(1488.456, 1124.697)
    expect(mapped(one, 492158)).toBe(499281)
    expect(mapped(two, 1117574)).toBe(1181030)
  })
  test('I: decreased/invalid duration drops all corrections and stays disabled', () => {
    for (const bad of [1400, NaN, Infinity, -1, 0, 4000]) {
      const session = tracker()
      session.sample(1425, 0)
      session.sample(1457.782, 492.158)
      const invalid = session.sample(bad, 520)
      expect(invalid.providerTimeline).toBeUndefined()
      expect(mapped(invalid, 1117574)).toBe(1117574)
      expect(session.sample(1457.782, 520).providerTimeline).toBeUndefined()
    }
  })
  test('I: invalid currentTime cannot establish ownership of a duration increase', () => {
    for (const position of [NaN, Infinity, -1, 2000]) {
      const session = tracker()
      session.sample(1425, 0)
      expect(
        session.sample(1457.782, position).providerTimeline
      ).toBeUndefined()
    }
  })
  test('J: initial insertion, skipped/multiple breaks and overlapping candidates are not apportioned', () => {
    expect(tracker().sample(1506.372, 1200).providerTimeline).toBeUndefined()
    for (const position of [10, 1148.940833, 1400]) {
      const session = tracker()
      session.sample(1425, 0)
      expect(
        session.sample(1506.372, position).providerTimeline
      ).toBeUndefined()
    }
    const close = tracker(evidence([492158, 500000]))
    close.sample(1425, 0)
    expect(close.sample(1457.782, 501).providerTimeline).toBeUndefined()
  })
  test('additional chunks at a confirmed break disable rather than misassign to next break', () => {
    const session = tracker()
    session.sample(1425, 0)
    session.sample(1457.782, 492.158)
    expect(session.sample(1465, 530).providerTimeline).toBeUndefined()
  })
  test('duplicate unchanged samples do not confirm additional breaks', () => {
    const session = tracker()
    session.sample(1425, 0)
    const first = session.sample(1457.782, 492.158)
    expect(session.sample(1457.782, 800)).toEqual(first)
  })
})
