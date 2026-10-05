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

describe('comment marker adapter', () => {
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

  test('does not map manual broadcast sources or guess provider anchors', () => {
    for (const type of ['jikkyo', 'normal', 'nicolog', 'file', 'szbh']) {
      expect(
        createCommentTimelinePlan(markerThreads(), { type }, provider).status
      ).toBe('unavailable')
    }
    expect(
      createCommentTimelinePlan(markerThreads(), { type: 'danime' }).status
    ).toBe('unavailable')
  })
})
