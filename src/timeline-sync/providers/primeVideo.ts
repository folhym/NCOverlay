import type { ProviderTimeline } from '@/timeline-sync/core'

interface PrimePlaylistEvidence {
  readonly index: number
  readonly type: string | null
  readonly startMs: number | null
  readonly endMs: number | null
  readonly rangeStatus: 'unverified' | 'missing' | 'invalid'
  readonly shouldShowOnScrubBar: boolean | null
  readonly nonLinearAdsCount: number | null
}

interface PrimeTransitionEvidence {
  readonly index: number
  readonly eventType: string | null
  readonly startTimeMs: number | null
  readonly intervalStartTimesMs: readonly (number | null)[]
}

export interface PrimeTimelineEvidence {
  readonly status: 'captured' | 'unavailable'
  readonly fullTitleDurationMs: number | null
  readonly intraTitlePlaylist: readonly PrimePlaylistEvidence[]
  readonly transitionEvents: readonly PrimeTransitionEvidence[]
}

export interface PrimeTimelineInspection {
  readonly providerTimeline?: ProviderTimeline
  readonly diagnostics: Omit<PrimeTimelineEvidence, 'status'> & {
    readonly status:
      | 'awaiting-field-verification'
      | 'resource-unavailable'
      | 'invalid-media-duration'
    readonly mediaDurationMs: number | null
    readonly mediaCurrentTimeMs: number | null
  }
}

// Opaque identifier labels only: do not forward URLs, queries or free text.
const LABEL_REGEXP = /^[a-z][a-z0-9_-]{0,63}$/i

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function time(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function mediaTime(value: unknown) {
  const seconds = time(value)
  return seconds === null ? null : time(seconds * 1000)
}

function label(value: unknown): string | null {
  return typeof value === 'string' && LABEL_REGEXP.test(value) ? value : null
}

function playlist(value: unknown, prepared: boolean): PrimePlaylistEvidence[] {
  if (!Array.isArray(value)) return []

  return value.map((item, index) => {
    const entry = record(item)
    const startMs = time(entry.startMs)
    const endMs = time(entry.endMs)
    const count = prepared
      ? entry.nonLinearAdsCount
      : Array.isArray(entry.nonLinearAds)
        ? entry.nonLinearAds.length
        : null

    return {
      index,
      type: label(entry.type),
      startMs,
      endMs,
      rangeStatus:
        (prepared && entry.rangeStatus === 'invalid') ||
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        (entry.startMs != null && startMs === null) ||
        (entry.endMs != null && endMs === null) ||
        (startMs !== null && endMs !== null && startMs > endMs)
          ? 'invalid'
          : startMs === null || endMs === null
            ? 'missing'
            : 'unverified',
      shouldShowOnScrubBar:
        typeof entry.shouldShowOnScrubBar === 'boolean'
          ? entry.shouldShowOnScrubBar
          : null,
      nonLinearAdsCount:
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
          ? count
          : null,
    }
  })
}

function transitions(
  value: unknown,
  prepared: boolean
): PrimeTransitionEvidence[] {
  if (!Array.isArray(value)) return []

  return value.map((item, index) => {
    const entry = record(item)
    const intervals = prepared ? entry.intervalStartTimesMs : entry.intervals

    return {
      index,
      eventType: label(entry.eventType),
      startTimeMs: time(entry.startTimeMs),
      intervalStartTimesMs: Array.isArray(intervals)
        ? intervals.map((interval) =>
            time(prepared ? interval : record(interval).startTimeMs)
          )
        : [],
    }
  })
}

/** Extract only evidence; neither label names nor duration differences imply ads. */
export function extractPrimeTimelineEvidence(
  resource: unknown
): PrimeTimelineEvidence {
  const root = record(resource)
  const playback = record(
    record(record(root.vodPlaylistedPlaybackUrls).result).playbackUrls
  )
  const transitionResult = record(record(root.transitionTimecodes).result)

  return {
    status:
      Object.keys(playback).length || Object.keys(transitionResult).length
        ? 'captured'
        : 'unavailable',
    fullTitleDurationMs: time(playback.fullTitleDurationMs),
    intraTitlePlaylist: playlist(playback.intraTitlePlaylist, false),
    transitionEvents: transitions(transitionResult.events, false),
  }
}

/** Rebuild the page-message snapshot from the same allowlist before using it. */
export function sanitizePrimeTimelineEvidence(
  evidence: unknown
): PrimeTimelineEvidence {
  const source = record(evidence)
  return {
    status: source.status === 'captured' ? 'captured' : 'unavailable',
    fullTitleDurationMs: time(source.fullTitleDurationMs),
    intraTitlePlaylist: playlist(source.intraTitlePlaylist, true),
    transitionEvents: transitions(source.transitionEvents, true),
  }
}

/** Static diagnostics alone never create mappings; dynamic tracking is separate. */
export function inspectPrimeTimeline(
  evidence: unknown,
  mediaDurationSeconds: number,
  mediaCurrentTimeSeconds: number
): PrimeTimelineInspection {
  const source = sanitizePrimeTimelineEvidence(evidence)
  const duration = mediaTime(mediaDurationSeconds)
  const mediaDurationMs = duration !== null && duration > 0 ? duration : null

  return {
    providerTimeline: undefined,
    diagnostics: {
      status:
        source.status !== 'captured'
          ? 'resource-unavailable'
          : mediaDurationMs === null
            ? 'invalid-media-duration'
            : 'awaiting-field-verification',
      mediaDurationMs,
      mediaCurrentTimeMs: mediaTime(mediaCurrentTimeSeconds),
      fullTitleDurationMs: source.fullTitleDurationMs,
      intraTitlePlaylist: source.intraTitlePlaylist,
      transitionEvents: source.transitionEvents,
    },
  }
}
