import { describe, expect, test } from 'bun:test'

import {
  createCommentTimelinePlan,
  findCommentTimelineAnchors,
} from '../../src/timeline-sync/commentTimeline'
import { mapTimelineTime } from '../../src/timeline-sync/core'
import { findMarkers } from '../../src/utils/api/jikkyo/findMarkers'

function markerThreads(count = 3) {
  return [
    {
      comments: ['A', 'B'].flatMap((body, index) =>
        Array.from({ length: count }, () => ({
          body,
          vposMs: index ? 810000 : 180000,
        }))
      ),
    },
  ]
}

const provider = {
  anchors: [
    { key: 'aPart', timeMs: 180000 },
    { key: 'bPart', timeMs: 720000 },
  ],
}

const alignments = Array.from({ length: 8 }, (_, index) => ({
  sourceTimeMs: index * 100000,
  targetTimeMs: index * 100000 + (index === 0 ? 0 : index % 2 ? 30000 : -30000),
  reason: `confirmed-break-${index}`,
}))

describe('comment marker adapter', () => {
  test('direct alignments take priority without requiring semantic markers', () => {
    const direct = { alignments, durationMs: 1500000 }
    const plan = createCommentTimelinePlan([], { type: 'official' }, direct)
    expect(plan.status).toBe('mapped')
    expect(plan.alignments).toEqual(alignments)
    expect(mapTimelineTime(810000, plan)).toBe(840000)

    const both = createCommentTimelinePlan(
      markerThreads(),
      { type: 'danime' },
      { ...provider, ...direct }
    )
    expect(mapTimelineTime(810000, both)).toBe(840000)
  })

  test('reuses findMarkers and MARKERS keys in source coordinates', () => {
    expect(findCommentTimelineAnchors(markerThreads())).toEqual([
      { key: 'aPart', timeMs: 180000, confidence: 1 },
      { key: 'bPart', timeMs: 810000, confidence: 1 },
    ])
    const plan = createCommentTimelinePlan(
      markerThreads(),
      { type: 'official' },
      provider
    )
    expect(mapTimelineTime(810000, plan)).toBe(720000)
  })

  test('does not auto-correct isolated marker comments', () => {
    // Existing callers retain their original one-comment detection behavior.
    expect(findMarkers(markerThreads(1), null)[2]).toBe(180000)
    const plan = createCommentTimelinePlan(
      markerThreads(1),
      { type: 'danime' },
      provider
    )
    expect(plan.status).toBe('unavailable')
    expect(mapTimelineTime(810000, plan)).toBe(810000)
  })

  test('requires support inside the existing detector window', () => {
    const threads = markerThreads()
    threads[0].comments.slice(0, 3).forEach((comment, index) => {
      comment.vposMs += index * 7900
    })
    expect(findCommentTimelineAnchors(threads)).toEqual([
      { key: 'bPart', timeMs: 810000, confidence: 1 },
    ])
  })

  test('undefined direct input retains semantic fallback through serialization', () => {
    const input = { ...provider, alignments: undefined }
    for (const timeline of [input, JSON.parse(JSON.stringify(input))]) {
      const plan = createCommentTimelinePlan(
        markerThreads(),
        { type: 'official' },
        timeline
      )
      expect(mapTimelineTime(810000, plan)).toBe(720000)
    }
  })

  test('invalid explicit direct input passes through without semantic fallback', () => {
    for (const direct of [
      null,
      [],
      {},
      [alignments[0]],
      [...alignments].reverse(),
      [alignments[0], { ...alignments[1], targetTimeMs: NaN }],
    ]) {
      const plan = createCommentTimelinePlan(
        markerThreads(),
        { type: 'official' },
        { ...provider, alignments: direct }
      )
      expect(plan.status).toBe('unavailable')
      expect(mapTimelineTime(810000, plan)).toBe(810000)
    }
  })

  test('direct input validates target duration and boundary bounds', () => {
    for (const durationMs of [-1, NaN, Infinity, 700000]) {
      const plan = createCommentTimelinePlan(
        markerThreads(),
        { type: 'official' },
        { ...provider, alignments, durationMs }
      )
      expect(plan.status).toBe('unavailable')
      expect(mapTimelineTime(810000, plan)).toBe(810000)
    }
  })

  test('rejects malformed provider containers before direct dispatch', () => {
    const malformed = Object.assign([], { alignments })
    const plan = createCommentTimelinePlan([], { type: 'official' }, malformed)
    expect(plan.reason).toBe('provider-anchors-invalid')
    expect(mapTimelineTime(810000, plan)).toBe(810000)
  })

  test('does not map manual broadcast sources or guess provider anchors', () => {
    for (const type of ['jikkyo', 'normal', 'nicolog', 'file', 'szbh']) {
      expect(
        createCommentTimelinePlan(markerThreads(), { type }, provider).status
      ).toBe('unavailable')
      expect(
        createCommentTimelinePlan([], { type }, { alignments }).status
      ).toBe('unavailable')
    }
    expect(
      createCommentTimelinePlan(markerThreads(), { type: 'danime' }).status
    ).toBe('unavailable')
  })
})
