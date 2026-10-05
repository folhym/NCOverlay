import type {
  Episode,
  Season,
  Video,
} from '@midra/nco-utils/types/api/netflix/metadata'
import type { ProviderTimeline } from '@/timeline-sync/core'

interface NetflixTimelineSource {
  readonly source: Video | Episode
  readonly season?: Season
  readonly episode?: Episode
}

interface UnverifiedRange {
  readonly status: 'unverified' | 'missing' | 'invalid'
  readonly startRaw: number | null
  readonly endRaw: number | null
}

export interface NetflixTimelineInspection {
  readonly providerTimeline?: ProviderTimeline
  readonly diagnostics: {
    readonly status:
      | 'awaiting-field-verification'
      | 'invalid-media-duration'
      | 'content-id-mismatch'
    readonly mediaDurationMs: number | null
    readonly fields: {
      readonly runtimeRaw: number | null
      readonly creditsOffsetRaw: number | null
      readonly credit: UnverifiedRange
      readonly recap: UnverifiedRange
      readonly intro: UnverifiedRange
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isWatchId(value: number) {
  return Number.isSafeInteger(value) && value > 0
}

/** Match the current watch ID, never the series' currentEpisode or a sibling. */
export function selectNetflixTimelineSource(
  metadata: Video | null,
  watchId: number
): NetflixTimelineSource | null {
  if (
    !isWatchId(watchId) ||
    !isRecord(metadata) ||
    typeof metadata.title !== 'string'
  ) {
    return null
  }

  if (metadata.seasons === undefined) {
    return metadata.id === watchId ? { source: metadata } : null
  }
  if (!Array.isArray(metadata.seasons)) return null

  for (const season of metadata.seasons) {
    if (
      !isRecord(season) ||
      typeof season.title !== 'string' ||
      !Array.isArray(season.episodes)
    ) {
      continue
    }

    const episode = season.episodes.find(
      (entry) =>
        isRecord(entry) &&
        entry.id === watchId &&
        typeof entry.title === 'string'
    )
    if (episode) return { source: episode, season, episode }
  }

  return null
}

function rawTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function inspectRange(value: unknown): UnverifiedRange {
  if (!isRecord(value)) {
    return {
      status: value == null ? 'missing' : 'invalid',
      startRaw: null,
      endRaw: null,
    }
  }

  const startRaw = rawTime(value.start)
  const endRaw = rawTime(value.end)
  const invalid =
    (value.start != null && startRaw === null) ||
    (value.end != null && endRaw === null) ||
    (startRaw !== null && endRaw !== null && startRaw >= endRaw)

  return {
    status: invalid
      ? 'invalid'
      : startRaw === null || endRaw === null
        ? 'missing'
        : 'unverified',
    startRaw,
    endRaw,
  }
}

/**
 * nco-utils 1.4.2 only declares numeric Netflix fields; it does not document
 * their units or correspondence to OP/A/ED. Keep them diagnostic-only until
 * verified against playback. Only HTMLMediaElement.duration is seconds here.
 */
export function inspectNetflixTimeline(
  source: Video | Episode,
  watchId: number,
  mediaDurationSeconds: number
): NetflixTimelineInspection {
  const duration = rawTime(mediaDurationSeconds)
  const durationMs = duration === null ? null : rawTime(duration * 1000)
  const mediaDurationMs =
    durationMs !== null && durationMs > 0 ? durationMs : null
  const fields: Record<string, unknown> = isRecord(source) ? source : {}
  const markers: Record<string, unknown> = isRecord(fields.skipMarkers)
    ? fields.skipMarkers
    : {}

  return {
    // No Netflix field is promoted to a trusted semantic anchor by its name.
    providerTimeline: undefined,
    diagnostics: {
      status:
        !isWatchId(watchId) || fields.id !== watchId
          ? 'content-id-mismatch'
          : mediaDurationMs === null
            ? 'invalid-media-duration'
            : 'awaiting-field-verification',
      mediaDurationMs,
      fields: {
        runtimeRaw: rawTime(fields.runtime),
        creditsOffsetRaw: rawTime(fields.creditsOffset),
        credit: inspectRange(markers.credit),
        recap: inspectRange(markers.recap),
        // Not declared in nco-utils; inspect only if actually present at runtime.
        intro: inspectRange(markers.intro),
      },
    },
  }
}
