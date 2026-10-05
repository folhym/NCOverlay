import type { MarkerKey } from '@/constants/markers'

import { MARKERS } from '@/constants/markers'

export type TimelineAnchorKey = MarkerKey

export interface TimelineAnchor {
  readonly key: TimelineAnchorKey
  readonly timeMs: number
  /** Undefined means that the caller explicitly trusts this anchor. */
  readonly confidence?: number
}

/** Target coordinates are the media clock consumed by NCOverlay's Renderer. */
export interface ProviderTimeline {
  readonly anchors: readonly TimelineAnchor[]
  readonly durationMs?: number
}

/** A caller-confirmed correspondence, not an inferred insertion or deletion. */
export interface TimelineAlignment {
  readonly sourceTimeMs: number
  readonly targetTimeMs: number
  readonly reason: string
}

export interface TimelineSegment {
  readonly sourceStartMs: number
  /** Half-open source interval; null denotes an unbounded final interval. */
  readonly sourceEndMs: number | null
  readonly adjustmentMs: number
  readonly reason: string
}

export type TimelinePlanReason =
  | 'same-timeline'
  | 'aligned'
  | 'provider-unavailable'
  | 'source-anchors-invalid'
  | 'provider-anchors-invalid'
  | 'provider-duration-invalid'
  | 'insufficient-shared-anchors'
  | 'shared-anchor-order-mismatch'
  | 'alignments-invalid'
  | 'insufficient-alignments'

export interface TimelinePlan {
  readonly status: 'unavailable' | 'identity' | 'mapped'
  readonly reason: TimelinePlanReason
  readonly segments: readonly TimelineSegment[]
  readonly alignments: readonly TimelineAlignment[]
}

const ANCHOR_KEYS = new Set<string>(MARKERS.map(({ key }) => key))
const MIN_CONFIDENCE = 0.8

function isTime(value: number) {
  return Number.isFinite(value) && value >= 0
}

function unavailable(reason: TimelinePlanReason): TimelinePlan {
  return { status: 'unavailable', reason, segments: [], alignments: [] }
}

function validAnchors(anchors: readonly TimelineAnchor[], durationMs?: number) {
  if (!Array.isArray(anchors)) return false

  const keys = new Set<string>()
  let previousTime = -1

  for (const anchor of anchors) {
    if (
      !anchor ||
      typeof anchor !== 'object' ||
      !ANCHOR_KEYS.has(anchor.key) ||
      keys.has(anchor.key) ||
      !isTime(anchor.timeMs) ||
      anchor.timeMs <= previousTime ||
      (durationMs !== undefined && durationMs < anchor.timeMs) ||
      (anchor.confidence !== undefined &&
        (!Number.isFinite(anchor.confidence) ||
          anchor.confidence < 0 ||
          1 < anchor.confidence))
    ) {
      return false
    }

    keys.add(anchor.key)
    previousTime = anchor.timeMs
  }

  return true
}

function trusted(anchor: TimelineAnchor) {
  return anchor.confidence === undefined || MIN_CONFIDENCE <= anchor.confidence
}

/** Invalid or insufficient evidence produces a pass-through unavailable plan. */
export function createTimelinePlan(
  sourceAnchors: readonly TimelineAnchor[],
  provider?: ProviderTimeline | null
): TimelinePlan {
  if (!validAnchors(sourceAnchors)) {
    return unavailable('source-anchors-invalid')
  }
  if (provider == null) return unavailable('provider-unavailable')
  if (typeof provider !== 'object' || Array.isArray(provider)) {
    return unavailable('provider-anchors-invalid')
  }
  if (provider.durationMs !== undefined && !isTime(provider.durationMs)) {
    return unavailable('provider-duration-invalid')
  }
  if (!validAnchors(provider.anchors, provider.durationMs)) {
    return unavailable('provider-anchors-invalid')
  }

  const source = sourceAnchors.filter(trusted)
  const target = provider.anchors.filter(trusted)
  const sourceKeys = new Set(source.map(({ key }) => key))
  const targetByKey = new Map(target.map((anchor) => [anchor.key, anchor]))
  const sharedSource = source.filter(({ key }) => targetByKey.has(key))
  const sharedTarget = target.filter(({ key }) => sourceKeys.has(key))

  if (sharedSource.length < 2) {
    return unavailable('insufficient-shared-anchors')
  }
  if (sharedSource.some(({ key }, index) => key !== sharedTarget[index]?.key)) {
    return unavailable('shared-anchor-order-mismatch')
  }

  return createTimelinePlanFromAlignments(
    sharedSource.map(({ key, timeMs }) => ({
      sourceTimeMs: timeMs,
      targetTimeMs: targetByKey.get(key)!.timeMs,
      reason: `anchor:${key}`,
    }))
  )
}

/**
 * Each boundary starts an absolute target-source offset. Negative steps may
 * overlap target ranges; this offset-only plan never guesses or deletes gaps.
 */
export function createTimelinePlanFromAlignments(
  alignments: readonly TimelineAlignment[]
): TimelinePlan {
  if (!Array.isArray(alignments)) return unavailable('alignments-invalid')

  let previousSource = -1
  let previousTarget = -1

  for (const alignment of alignments) {
    if (
      !alignment ||
      typeof alignment !== 'object' ||
      !isTime(alignment.sourceTimeMs) ||
      !isTime(alignment.targetTimeMs) ||
      alignment.sourceTimeMs <= previousSource ||
      alignment.targetTimeMs <= previousTarget ||
      typeof alignment.reason !== 'string' ||
      !alignment.reason.trim()
    ) {
      return unavailable('alignments-invalid')
    }
    previousSource = alignment.sourceTimeMs
    previousTarget = alignment.targetTimeMs
  }

  if (alignments.length < 2) return unavailable('insufficient-alignments')

  const segments: TimelineSegment[] = []
  const first = alignments[0]!

  if (0 < first.sourceTimeMs) {
    segments.push({
      sourceStartMs: 0,
      sourceEndMs: first.sourceTimeMs,
      adjustmentMs: 0,
      reason: 'before-first-alignment',
    })
  }

  for (let index = 0; index < alignments.length; index++) {
    const alignment = alignments[index]!
    segments.push({
      sourceStartMs: alignment.sourceTimeMs,
      sourceEndMs: alignments[index + 1]?.sourceTimeMs ?? null,
      adjustmentMs: alignment.targetTimeMs - alignment.sourceTimeMs,
      reason: alignment.reason,
    })
  }

  const identity = segments.every(({ adjustmentMs }) => adjustmentMs === 0)

  return {
    status: identity ? 'identity' : 'mapped',
    reason: identity ? 'same-timeline' : 'aligned',
    segments,
    alignments: alignments.map((alignment) => ({ ...alignment })),
  }
}

function validSegments(segments: readonly TimelineSegment[]) {
  if (!Array.isArray(segments) || !segments.length) return false

  let nextStart = 0

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    if (
      !segment ||
      typeof segment !== 'object' ||
      segment.sourceStartMs !== nextStart ||
      !isTime(segment.sourceStartMs) ||
      !Number.isFinite(segment.adjustmentMs) ||
      !isTime(segment.sourceStartMs + segment.adjustmentMs) ||
      typeof segment.reason !== 'string'
    ) {
      return false
    }

    if (segment.sourceEndMs === null) return index === segments.length - 1
    if (
      !isTime(segment.sourceEndMs) ||
      segment.sourceEndMs <= segment.sourceStartMs
    ) {
      return false
    }
    nextStart = segment.sourceEndMs
  }

  return false
}

/** No plan, unavailable plan, or malformed plan leaves the source time intact. */
export function mapTimelineTime(
  timeMs: number,
  plan?: TimelinePlan | null
): number {
  if (
    !isTime(timeMs) ||
    !plan ||
    plan.status !== 'mapped' ||
    !validSegments(plan.segments)
  ) {
    return timeMs
  }

  const segment = plan.segments.find(
    ({ sourceStartMs, sourceEndMs }) =>
      sourceStartMs <= timeMs && (sourceEndMs === null || timeMs < sourceEndMs)
  )
  const mapped = timeMs + (segment?.adjustmentMs ?? 0)

  return isTime(mapped) ? mapped : timeMs
}
