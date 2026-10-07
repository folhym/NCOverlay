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
  test('reported 1457.032s / 504.910584s sample lies inside the existing first-break window', () => {
    const session = tracker()
    session.sample(1425, 0)
    const first = session.sample(1457.032, 504.910584)
    expect(first.diagnostics.status).toBe('tracking')
    expect(first.diagnostics.confirmedBreakCount).toBe(1)
    expect(first.diagnostics.cumulativeInsertionMs).toBe(32032)
    expect(mapped(first, 492158)).toBe(524190)
    // Latest second duration, with an illustrative position from the earlier
    // observation. The user has not supplied this run's second event position.
    const second = session.sample(1506.081, 1200.543033)
    expect(second.diagnostics.status).toBe('tracking')
    expect(second.diagnostics.confirmedBreakCount).toBe(2)
    expect(second.diagnostics.cumulativeInsertionMs).toBe(81081)
    expect(mapped(second, 1117574)).toBe(1198655)
  })
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
      let one = session.sample(1457.782, first)
      if (first < 492.158) {
        expect(one.diagnostics.confirmedBreakCount).toBe(0)
        one = session.sample(1457.782, 492.158, 'timeupdate')
      }
      expect(one.diagnostics.cumulativeInsertionMs).toBe(32782)
      expect(mapped(one, 492157)).toBe(492157)
      expect(mapped(one, 492158)).toBe(524940)
      let two = session.sample(1506.372, second)
      if (second < 1150.356) {
        expect(two.diagnostics.confirmedBreakCount).toBe(1)
        two = session.sample(1506.372, 1150.356, 'timeupdate')
      }
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
    for (const position of [1148.940833, 1400]) {
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
  test('additional chunks amend only the latest active break without advancing its count', () => {
    const session = tracker()
    session.sample(1425, 0)
    const partial = session.sample(1456, 492.158)
    expect(partial.diagnostics.confirmedBreakCount).toBe(1)
    const first = session.sample(1457.032, 504.910584)
    expect(first.diagnostics.confirmedBreakCount).toBe(1)
    expect(mapped(first, 492158)).toBe(524190)
    session.sample(1457.032, 1148.94, 'timeupdate')
    const second = session.sample(1502, 1148.94)
    expect(second.diagnostics.confirmedBreakCount).toBe(1)
    expect(
      session.sample(1502, 1149.606, 'timeupdate').diagnostics
        .confirmedBreakCount
    ).toBe(2)
    const amended = session.sample(1506.081, 1200.543033)
    expect(amended.diagnostics.status).toBe('tracking')
    expect(amended.diagnostics.confirmedBreakCount).toBe(2)
    expect(mapped(amended, 1117574)).toBe(1198655)
    expect(mapped(amended, 492158)).toBe(524190)
  })
  test('duplicate unchanged samples do not confirm additional breaks', () => {
    const session = tracker()
    session.sample(1425, 0)
    const first = session.sample(1457.782, 492.158)
    const again = session.sample(1457.782, 800, 'timeupdate')
    expect(again.providerTimeline).toEqual(first.providerTimeline)
    expect(again.diagnostics.confirmedBreakCount).toBe(1)
  })
  test('clock reset with a unique preceding sample defers then confirms each variable break', () => {
    const session = tracker()
    session.sample(1425, 0)
    session.sample(1425, 490, 'timeupdate')
    const pending = session.sample(1457.032, 0.907524)
    expect(pending.diagnostics.status).toBe('tracking')
    expect(pending.diagnostics.reason).toBe('awaiting-break-position')
    expect(pending.diagnostics.confirmedBreakCount).toBe(0)
    expect(pending.diagnostics.cumulativeInsertionMs).toBe(32032)
    expect(pending.diagnostics.confirmedCumulativeInsertionMs).toBe(0)
    expect(mapped(pending, 492158)).toBe(492158)
    session.sample(1457.032, 1, 'timeupdate')
    const first = session.sample(1457.032, 504.910584, 'pause')
    expect(first.diagnostics.confirmedBreakCount).toBe(1)
    expect(mapped(first, 492158)).toBe(524190)
    session.sample(1457.032, 1148.94, 'timeupdate')
    const later = session.sample(1506.081, 0.2)
    expect(later.diagnostics.pendingBreakIndex).toBe(1)
    expect(later.diagnostics.confirmedBreakCount).toBe(1)
    expect(mapped(later, 1117574)).toBe(1149606)
    const second = session.sample(1506.081, 1200.543033, 'playing')
    expect(second.diagnostics.status).toBe('tracking')
    expect(second.diagnostics.confirmedBreakCount).toBe(2)
    expect(mapped(second, 1117574)).toBe(1198655)
  })
  test('sealed break cannot be recaptured by later duration growth or a seek', () => {
    for (const event of ['timeupdate', 'seeking', 'seeked']) {
      const session = tracker()
      session.sample(1425, 0)
      session.sample(1456, 492.158)
      session.sample(1456, event === 'timeupdate' ? 800 : 492.158, event)
      expect(
        session.sample(1457.032, 504.910584).providerTimeline
      ).toBeUndefined()
    }
  })
  test('a pending insertion is rejected on seeking, decreasing duration or skipped ownership', () => {
    for (const [duration, position, event, reason] of [
      [1457.032, 504.910584, 'seeking', 'ambiguous-playback-seek'],
      [1457.032, 504.910584, 'seeked', 'ambiguous-playback-seek'],
      [1456, 0, 'durationchange', 'duration-decreased'],
      [1457.032, 1200, 'timeupdate', 'ambiguous-duration-growth'],
    ]) {
      const session = tracker()
      session.sample(1425, 0)
      session.sample(1425, 490, 'timeupdate')
      session.sample(1457.032, 0.907524)
      const result = session.sample(duration, position, event)
      expect(result.providerTimeline).toBeUndefined()
      expect(result.diagnostics.reason).toBe(reason)
    }
  })
  test('a seek removes the preceding-position hint before a transient reset', () => {
    const session = tracker()
    session.sample(1425, 0)
    session.sample(1425, 490, 'timeupdate')
    session.sample(1425, 490, 'seeking')
    expect(session.sample(1457.032, 0.907524).providerTimeline).toBeUndefined()
  })
  test('timeupdate during an unfinished seek cannot restore ownership or promote growth', () => {
    const session = tracker()
    session.sample(1425, 0)
    session.sample(1425, 490, 'timeupdate')
    session.sample(1425, 490, 'seeking')
    session.sample(1425, 490, 'timeupdate')
    const result = session.sample(1457.032, 0.907524)
    expect(result.diagnostics.reason).toBe('ambiguous-playback-seek')
    expect(result.providerTimeline).toBeUndefined()
    expect(
      session.sample(1457.032, 504.910584, 'pause').providerTimeline
    ).toBeUndefined()
    expect(
      session.sample(1457.032, 504.910584, 'seeked').providerTimeline
    ).toBeUndefined()
  })
  test('diagnostics record the sampled clock and event instead of inferring a later console value', () => {
    const session = tracker()
    session.sample(1425, 0)
    const result = session.sample(1457.032, 504.910584)
    expect(result.diagnostics.event).toBe('durationchange')
    expect(result.diagnostics.mediaCurrentTimeMs).toBe(504910.584)
    expect(result.diagnostics.previousMediaCurrentTimeMs).toBe(0)
    expect(result.diagnostics.candidateBreakIndices).toEqual([0])
    expect(result.diagnostics.sourceBreakTimesMs).toEqual([492158, 1117574])
  })
  test('measured 44.695s preallocation stays identity until the actual first mapped boundary', () => {
    const session = tracker(evidence([407365, 963963]))
    session.sample(1425, 12.89844, 'initial')
    session.sample(1425, 362.662287, 'timeupdate')
    const pending = session.sample(1473.798, 362.669901)
    expect(pending.diagnostics).toMatchObject({
      status: 'tracking',
      reason: 'preloaded-next-break',
      confirmedBreakCount: 0,
      pendingBreakIndex: 0,
      cumulativeInsertionMs: 48798,
      pendingCumulativeInsertionMs: 48798,
      confirmedCumulativeInsertionMs: 0,
    })
    expect(pending.providerTimeline.alignments).toHaveLength(1)
    expect(mapped(pending, 300000)).toBe(300000)
    expect(mapped(pending, 407365)).toBe(407365)
    expect(
      session.sample(1473.798, 407.364999, 'timeupdate').diagnostics
        .confirmedBreakCount
    ).toBe(0)
    const confirmed = session.sample(1473.798, 407.365, 'timeupdate')
    expect(confirmed.diagnostics.confirmedBreakCount).toBe(1)
    expect(confirmed.diagnostics.confirmedCumulativeInsertionMs).toBe(48798)
    expect(confirmed.diagnostics.pendingCumulativeInsertionMs).toBeNull()
    expect(mapped(confirmed, 407364)).toBe(407364)
    expect(mapped(confirmed, 407365)).toBe(456163)
  })
  test('chunked preloads for both breaks update pending cumulative without early activation', () => {
    const session = tracker(evidence([407365, 963963]))
    session.sample(1425, 12.89844)
    for (const [cumulative, position] of [
      [30000, 350],
      [42000, 356],
      [48798, 362.669901],
    ]) {
      const pending = session.sample((1425000 + cumulative) / 1000, position)
      expect(pending.diagnostics.confirmedBreakCount).toBe(0)
      expect(pending.diagnostics.pendingCumulativeInsertionMs).toBe(cumulative)
      expect(mapped(pending, 407365)).toBe(407365)
    }
    const first = session.sample(1473.798, 407.365, 'timeupdate')
    expect(mapped(first, 407365)).toBe(456163)
    session.sample(1473.798, 800, 'timeupdate')
    // Second preload timings/amounts are synthetic variable-ad examples.
    for (const [cumulative, position] of [
      [70000, 900],
      [81081, 970],
    ]) {
      const pending = session.sample((1425000 + cumulative) / 1000, position)
      expect(pending.diagnostics.confirmedBreakCount).toBe(1)
      expect(pending.diagnostics.pendingBreakIndex).toBe(1)
      expect(pending.diagnostics.confirmedCumulativeInsertionMs).toBe(48798)
      expect(mapped(pending, 963963)).toBe(1012761)
      expect(mapped(pending, 407365)).toBe(456163)
    }
    expect(
      session.sample(1506.081, 1012.760999, 'pause').diagnostics
        .confirmedBreakCount
    ).toBe(1)
    const second = session.sample(1506.081, 1012.761, 'timeupdate')
    expect(second.diagnostics.confirmedBreakCount).toBe(2)
    expect(mapped(second, 963963)).toBe(1045044)
    expect(mapped(second, 963962)).toBe(1012760)
  })
  test('preload inside the 5-second tolerance still waits for actual break start', () => {
    const session = tracker(evidence([407365, 963963]))
    session.sample(1425, 400)
    const pending = session.sample(1473.798, 405)
    expect(pending.diagnostics.confirmedBreakCount).toBe(0)
    expect(
      session.sample(1473.798, 407.364, 'timeupdate').diagnostics
        .confirmedBreakCount
    ).toBe(0)
    expect(
      session.sample(1473.798, 407.365, 'timeupdate').diagnostics
        .confirmedBreakCount
    ).toBe(1)
  })
  test('preload safety rejects overlapping windows, missed break, seek, decrease and unowned backward reset', () => {
    const close = tracker(evidence([407365, 430000]))
    close.sample(1425, 12)
    expect(close.sample(1473.798, 362.669901).providerTimeline).toBeUndefined()
    for (const [duration, position, event] of [
      [1473.798, 600, 'timeupdate'],
      [1473.798, 1100, 'timeupdate'],
      [1473.798, 407.365, 'seeking'],
      [1467, 363, 'durationchange'],
      [2025, 363, 'durationchange'],
      [NaN, 363, 'durationchange'],
      [1473.798, NaN, 'timeupdate'],
    ]) {
      const session = tracker(evidence([407365, 963963]))
      session.sample(1425, 12.89844)
      session.sample(1473.798, 362.669901)
      expect(
        session.sample(duration, position, event).providerTimeline
      ).toBeUndefined()
    }
    const reset = tracker(evidence([407365, 963963]))
    reset.sample(1425, 12.89844)
    expect(reset.sample(1473.798, 0.907524).providerTimeline).toBeUndefined()
  })
})
