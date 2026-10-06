import type {
  Episode,
  Season,
  Video,
} from '@midra/nco-utils/types/api/netflix/metadata'
import type { ProviderTimeline } from '@/timeline-sync/core'

type NetflixTimelineSource =
  | {
      readonly kind: 'episode'
      readonly source: Episode
      readonly season: Season
      readonly episode: Episode
    }
  | {
      readonly kind: 'standalone'
      readonly source: Video
      readonly season?: undefined
      readonly episode?: undefined
    }

interface NetflixMarkerRange {
  readonly status: 'confirmed' | 'unverified' | 'missing' | 'invalid'
  readonly startRaw: number | null
  readonly endRaw: number | null
}

export interface NetflixTimelineInspection {
  readonly providerTimeline?: ProviderTimeline
  readonly diagnostics: {
    readonly status:
      | 'ready'
      | 'source-unverified'
      | 'credit-unavailable'
      | 'invalid-media-duration'
      | 'content-id-mismatch'
    readonly mediaDurationMs: number | null
    readonly fields: {
      readonly runtimeRaw: number | null
      readonly creditsOffsetRaw: number | null
      readonly credit: NetflixMarkerRange
      readonly recap: NetflixMarkerRange
      readonly intro: NetflixMarkerRange
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
    return metadata.id === watchId
      ? { kind: 'standalone', source: metadata }
      : null
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
    if (episode) return { kind: 'episode', source: episode, season, episode }
  }

  return null
}

function rawTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function inspectRange(value: unknown): NetflixMarkerRange {
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
 * Verification covers two Episodes of one work: credit is the intro skip
 * interval in ms (start → OP, end → A part). Only an Episode selected from
 * seasons may use it. Standalone Video and other fields stay diagnostic-only.
 * Media duration is in seconds.
 */
export function inspectNetflixTimeline(
  selected: NetflixTimelineSource,
  watchId: number,
  mediaDurationSeconds: number
): NetflixTimelineInspection {
  const duration = rawTime(mediaDurationSeconds)
  const durationMs = duration === null ? null : rawTime(duration * 1000)
  const mediaDurationMs =
    durationMs !== null && durationMs > 0 ? durationMs : null
  const source = isRecord(selected) ? selected.source : undefined
  const isEpisode = isRecord(selected) && selected.kind === 'episode'
  const fields: Record<string, unknown> = isRecord(source) ? source : {}
  const markers: Record<string, unknown> = isRecord(fields.skipMarkers)
    ? fields.skipMarkers
    : {}
  const matchesContent = isWatchId(watchId) && fields.id === watchId
  let credit = inspectRange(markers.credit)
  let providerTimeline: ProviderTimeline | undefined

  if (isEpisode && mediaDurationMs !== null && credit.status === 'unverified') {
    if (credit.endRaw !== null && credit.endRaw > mediaDurationMs) {
      credit = { ...credit, status: 'invalid' }
    } else if (
      matchesContent &&
      credit.startRaw !== null &&
      credit.endRaw !== null
    ) {
      providerTimeline = {
        anchors: [
          { key: 'op', timeMs: credit.startRaw },
          { key: 'aPart', timeMs: credit.endRaw },
        ],
        durationMs: mediaDurationMs,
      }
      credit = { ...credit, status: 'confirmed' }
    }
  }

  return {
    providerTimeline,
    diagnostics: {
      status: !matchesContent
        ? 'content-id-mismatch'
        : mediaDurationMs === null
          ? 'invalid-media-duration'
          : !isEpisode
            ? 'source-unverified'
            : providerTimeline
              ? 'ready'
              : 'credit-unavailable',
      mediaDurationMs,
      fields: {
        runtimeRaw: rawTime(fields.runtime),
        creditsOffsetRaw: rawTime(fields.creditsOffset),
        credit,
        recap: inspectRange(markers.recap),
        // Not declared in nco-utils; inspect only if actually present at runtime.
        intro: inspectRange(markers.intro),
      },
    },
  }
}
