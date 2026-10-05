import type * as ThreadsV1 from '@midra/nco-utils/types/api/niconico/threads/v1'
import type { StateSlotDetail } from '@/ncoverlay/state'
import type { ProviderTimeline, TimelineAnchor } from './core'

import { MARKERS } from '@/constants/markers'
import { findMarkers } from '@/utils/api/jikkyo/findMarkers'

import { createTimelinePlan, createTimelinePlanFromAlignments } from './core'
import { isTimelineSyncSource } from './sourcePolicy'

/** Reuse the existing detector in source coordinates, without VOD chapter bounds. */
export function findCommentTimelineAnchors(
  threads: ThreadsV1.Thread[]
): TimelineAnchor[] {
  // Three comments in the detector's existing 8s window are required.
  // This is an evidence threshold, not a statistical confidence estimate.
  const positions = findMarkers(threads, null, 3)

  return MARKERS.flatMap(({ key }, index) => {
    const timeMs = positions[index]

    if (timeMs == null) return []

    return [{ key, timeMs, confidence: 1 }]
  })
}

export function createCommentTimelinePlan(
  threads: ThreadsV1.Thread[],
  detail: Pick<StateSlotDetail, 'type'>,
  providerTimeline?: ProviderTimeline | null
) {
  if (!isTimelineSyncSource(detail) || !providerTimeline) {
    return createTimelinePlan([], null)
  }

  if (typeof providerTimeline !== 'object' || Array.isArray(providerTimeline)) {
    return createTimelinePlan([], providerTimeline)
  }

  if (providerTimeline.alignments !== undefined) {
    return createTimelinePlanFromAlignments(
      providerTimeline.alignments,
      providerTimeline.durationMs
    )
  }

  return createTimelinePlan(
    findCommentTimelineAnchors(threads),
    providerTimeline
  )
}
