import { test } from 'bun:test'
import assert from 'node:assert/strict'

import {
  createTimelinePlan,
  createTimelinePlanFromAlignments,
  mapTimelineTime,
} from '../../src/timeline-sync/core'

const anchor = (key, timeMs, confidence) => ({ key, timeMs, confidence })
const source = [anchor('aPart', 180000), anchor('bPart', 810000)]
const provider = {
  anchors: [anchor('aPart', 180000), anchor('bPart', 720000)],
}

test('A: identical timelines produce zero correction', () => {
  const plan = createTimelinePlan(source, { anchors: source })
  assert.equal(plan.status, 'identity')
  for (const time of [0, 179999, 180000, 810000, 1000000]) {
    assert.equal(mapTimelineTime(time, plan), time)
  }
})

test('B: B part and subsequent comments receive an absolute -90000 ms offset', () => {
  const plan = createTimelinePlan(source, provider)
  assert.equal(plan.status, 'mapped')
  assert.equal(mapTimelineTime(810000, plan), 720000)
  assert.equal(mapTimelineTime(900000, plan), 810000)
  assert.equal(mapTimelineTime(809999, plan), 809999)
})

test('C: +30000 then -60000 ms differences accumulate to -30000 ms', () => {
  const plan = createTimelinePlanFromAlignments([
    { sourceTimeMs: 0, targetTimeMs: 0, reason: 'start' },
    {
      sourceTimeMs: 100000,
      targetTimeMs: 130000,
      reason: 'confirmed-addition',
    },
    {
      sourceTimeMs: 200000,
      targetTimeMs: 170000,
      reason: 'confirmed-difference',
    },
  ])
  assert.equal(plan.status, 'mapped')
  assert.equal(mapTimelineTime(99999, plan), 99999)
  assert.equal(mapTimelineTime(100000, plan), 130000)
  assert.equal(mapTimelineTime(199999, plan), 229999)
  assert.equal(mapTimelineTime(200000, plan), 170000)
  assert.equal(mapTimelineTime(300000, plan), 270000)
})

test('missing B anchors only correct the confirmed ED boundary', () => {
  const plan = createTimelinePlan(
    [anchor('op', 90000), anchor('aPart', 180000), anchor('ed', 1200000)],
    {
      anchors: [
        anchor('op', 90000),
        anchor('aPart', 180000),
        anchor('ed', 1110000),
      ],
    }
  )
  assert.equal(plan.status, 'mapped')
  assert.equal(mapTimelineTime(810000, plan), 810000)
  assert.equal(mapTimelineTime(1199999, plan), 1199999)
  assert.equal(mapTimelineTime(1200000, plan), 1110000)
  assert.deepEqual(
    plan.alignments.map(({ reason }) => reason),
    ['anchor:op', 'anchor:aPart', 'anchor:ed']
  )
})

test('D: absent provider and insufficient anchors never invent a correction', () => {
  for (const plan of [
    createTimelinePlan(source),
    createTimelinePlan(source, null),
    createTimelinePlan([source[0]], provider),
    createTimelinePlan([], provider),
    createTimelinePlan(source, { anchors: [] }),
    createTimelinePlanFromAlignments([]),
    createTimelinePlanFromAlignments([
      { sourceTimeMs: 0, targetTimeMs: 30000, reason: 'one-point-only' },
    ]),
  ]) {
    assert.equal(plan.status, 'unavailable')
    assert.deepEqual(plan.segments, [])
    assert.equal(mapTimelineTime(900000, plan), 900000)
  }
})

test('E: malformed, duplicate, reverse, or non-finite anchors fail safe', () => {
  const invalidSources = [
    undefined,
    null,
    [undefined, source[1]],
    [{ key: 'aPart' }, source[1]],
    [anchor('unknown', 0), source[1]],
    [anchor('aPart', -1), source[1]],
    [anchor('aPart', NaN), source[1]],
    [anchor('aPart', Infinity), source[1]],
    [anchor('aPart', '180000'), source[1]],
    [anchor('aPart', 180000), anchor('aPart', 810000)],
    [anchor('aPart', 180000), anchor('bPart', 180000)],
    [...source].reverse(),
    [anchor('aPart', 180000, -0.1), source[1]],
    [anchor('aPart', 180000, 1.1), source[1]],
    [anchor('aPart', 180000, NaN), source[1]],
    [anchor('aPart', 180000, null), source[1]],
  ]
  for (const anchors of invalidSources) {
    const plan = createTimelinePlan(anchors, provider)
    assert.equal(plan.status, 'unavailable')
    assert.equal(mapTimelineTime(900000, plan), 900000)
  }
  for (const target of [
    {},
    { anchors: [...provider.anchors].reverse() },
    { anchors: [anchor('aPart', 0), anchor('bPart', NaN)] },
    { anchors: provider.anchors, durationMs: -1 },
    { anchors: provider.anchors, durationMs: Infinity },
    { anchors: provider.anchors, durationMs: 719999 },
  ]) {
    const plan = createTimelinePlan(source, target)
    assert.equal(plan.status, 'unavailable')
    assert.equal(mapTimelineTime(900000, plan), 900000)
  }
})

test('F: existing positive Global and Slot offsets delay the mapped comment', () => {
  const plan = createTimelinePlan(source, provider)
  const globalOffsetSeconds = 15
  const slotOffsetMs = 2500
  const mappedCommentMs = mapTimelineTime(900000, plan) + slotOffsetMs
  const displayedAtMediaMs = mappedCommentMs + globalOffsetSeconds * 1000
  assert.equal(displayedAtMediaMs, 827500)
  assert.equal(displayedAtMediaMs - globalOffsetSeconds * 1000, mappedCommentMs)
  assert.equal(globalOffsetSeconds, 15)
  assert.equal(slotOffsetMs, 2500)
})

test('shared keys must have the same order in both increasing timelines', () => {
  const plan = createTimelinePlan(source, {
    anchors: [anchor('bPart', 180000), anchor('aPart', 720000)],
  })
  assert.equal(plan.reason, 'shared-anchor-order-mismatch')
  assert.equal(mapTimelineTime(900000, plan), 900000)
})

test('confidence below 0.8 is excluded; omitted confidence is explicit trust', () => {
  const low = createTimelinePlan(
    [anchor('aPart', 180000, 0.79), source[1]],
    provider
  )
  assert.equal(low.reason, 'insufficient-shared-anchors')
  const lowTarget = createTimelinePlan(source, {
    anchors: [provider.anchors[0], anchor('bPart', 720000, 0.79)],
  })
  assert.equal(lowTarget.status, 'unavailable')
  const accepted = createTimelinePlan(
    [anchor('aPart', 180000, 0.8), source[1]],
    provider
  )
  assert.equal(mapTimelineTime(900000, accepted), 810000)
})

test('half-open boundaries, untouched prefix, and serializable unbounded tail', () => {
  const plan = createTimelinePlan(
    [anchor('aPart', 180000), anchor('bPart', 810000)],
    { anchors: [anchor('aPart', 210000), anchor('bPart', 840000)] }
  )
  assert.equal(mapTimelineTime(179999, plan), 179999)
  assert.equal(mapTimelineTime(180000, plan), 210000)
  assert.equal(mapTimelineTime(809999, plan), 839999)
  assert.equal(mapTimelineTime(810000, plan), 840000)
  assert.equal(plan.segments.at(-1).sourceEndMs, null)
  const serialized = JSON.parse(JSON.stringify(plan))
  assert.equal(mapTimelineTime(900000, serialized), 930000)
})

test('arbitrary many confirmed alignments are not limited by marker count', () => {
  const alignments = Array.from({ length: 64 }, (_, index) => ({
    sourceTimeMs: index * 1000000,
    targetTimeMs:
      index * 1000000 + (index === 0 ? 0 : index % 2 ? 30000 : -60000),
    reason: `confirmed-boundary:${index}`,
  }))
  const plan = createTimelinePlanFromAlignments(alignments)
  assert.equal(plan.alignments.length, 64)
  for (const alignment of alignments) {
    assert.equal(
      mapTimelineTime(alignment.sourceTimeMs, plan),
      alignment.targetTimeMs
    )
  }
})

test('alignment input is validated without sorting away reverse evidence', () => {
  const valid = [
    { sourceTimeMs: 0, targetTimeMs: 0, reason: 'start' },
    { sourceTimeMs: 100, targetTimeMs: 130, reason: 'next' },
  ]
  for (const alignments of [
    undefined,
    [null, valid[1]],
    [...valid].reverse(),
    [valid[0], { ...valid[1], sourceTimeMs: 0 }],
    [valid[0], { ...valid[1], targetTimeMs: 0 }],
    [valid[0], { ...valid[1], targetTimeMs: NaN }],
    [valid[0], { ...valid[1], sourceTimeMs: -1 }],
    [valid[0], { ...valid[1], reason: '' }],
  ]) {
    const plan = createTimelinePlanFromAlignments(alignments)
    assert.equal(plan.status, 'unavailable')
    assert.equal(mapTimelineTime(100, plan), 100)
  }
})

test('malformed externally supplied plans and invalid query times pass through', () => {
  for (const plan of [
    undefined,
    null,
    {},
    { status: 'mapped' },
    { status: 'mapped', segments: [] },
    {
      status: 'mapped',
      segments: [
        {
          sourceStartMs: 0,
          sourceEndMs: null,
          adjustmentMs: NaN,
          reason: 'bad',
        },
      ],
    },
    {
      status: 'mapped',
      segments: [
        {
          sourceStartMs: 0,
          sourceEndMs: null,
          adjustmentMs: -1,
          reason: 'bad',
        },
      ],
    },
  ]) {
    assert.equal(mapTimelineTime(900000, plan), 900000)
  }
  const plan = createTimelinePlan(source, provider)
  assert.equal(mapTimelineTime(-1, plan), -1)
  assert.equal(mapTimelineTime(Infinity, plan), Infinity)
  assert.ok(Number.isNaN(mapTimelineTime(NaN, plan)))
})

test('negative steps do not infer deletion or pretend to be an invertible map', () => {
  const plan = createTimelinePlan(source, provider)
  assert.equal(mapTimelineTime(720000, plan), 720000)
  assert.equal(mapTimelineTime(810000, plan), 720000)
  assert.ok(mapTimelineTime(809999, plan) > mapTimelineTime(810000, plan))
})

test('frozen input arrays are untouched and retained evidence is copied', () => {
  const frozen = Object.freeze(
    source.map((value) => Object.freeze({ ...value }))
  )
  const before = JSON.stringify(frozen)
  createTimelinePlan(frozen, provider)
  assert.equal(JSON.stringify(frozen), before)
  const alignments = [
    { sourceTimeMs: 0, targetTimeMs: 0, reason: 'start' },
    { sourceTimeMs: 100, targetTimeMs: 130, reason: 'next' },
  ]
  const plan = createTimelinePlanFromAlignments(alignments)
  alignments[1].targetTimeMs = 999
  assert.equal(plan.alignments[1].targetTimeMs, 130)
  assert.equal(mapTimelineTime(100, plan), 130)
})
