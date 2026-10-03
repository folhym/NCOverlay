/** Temporary, read-only instrumentation for the offset-reset investigation. */
export type OffsetDiagnosticFields = Record<
  string,
  string | number | boolean | null | undefined
>

export type OffsetDiagnosticLogger = (
  event: string,
  fields?: OffsetDiagnosticFields
) => void

export interface OffsetDiagnostics {
  readonly provider: string
  readonly generation: string
  metadataSource?: 'native' | 'synthetic'
  log: OffsetDiagnosticLogger
}

interface VideoObservation {
  id: string
  src: string
  currentSrc: string
  srcRevision: number
  currentSrcRevision: number
}

const videos = new WeakMap<HTMLVideoElement, VideoObservation>()
let videoSequence = 0
let generationSequence = 0

function sourceKind(src: string) {
  if (!src) return 'none'
  if (src.startsWith('blob:')) return 'blob'
  if (src.startsWith('https:')) return 'https'
  if (src.startsWith('http:')) return 'http'
  return 'other'
}

/** Keep URLs only for in-memory comparison; never include them in a log. */
export function getDiagnosticVideoSnapshot(
  video: HTMLVideoElement
): OffsetDiagnosticFields {
  try {
    const src = video.src
    const currentSrc = video.currentSrc
    let observed = videos.get(video)

    if (!observed) {
      observed = {
        id: `video-${++videoSequence}`,
        src,
        currentSrc,
        srcRevision: 0,
        currentSrcRevision: 0,
      }
      videos.set(video, observed)
    } else {
      if (observed.src !== src) {
        observed.src = src
        observed.srcRevision++
      }
      if (observed.currentSrc !== currentSrc) {
        observed.currentSrc = currentSrc
        observed.currentSrcRevision++
      }
    }

    return {
      videoId: observed.id,
      srcKind: sourceKind(src),
      srcRevision: observed.srcRevision,
      currentSrcKind: sourceKind(currentSrc),
      currentSrcRevision: observed.currentSrcRevision,
      currentTimeSeconds: video.currentTime,
      durationSeconds: video.duration,
      paused: video.paused,
      playbackRate: video.playbackRate,
      readyState: video.readyState,
      isConnected: video.isConnected,
    }
  } catch {
    return { videoSnapshotUnavailable: true }
  }
}

/** Emit immutable, primitive-only records. Diagnostics must never abort playback. */
export function emitOffsetDiagnostic(
  event: string,
  fields: OffsetDiagnosticFields = {}
) {
  try {
    const snapshot: OffsetDiagnosticFields = {}
    for (const [key, value] of Object.entries(fields)) {
      if (typeof value === 'number') {
        snapshot[key] = Number.isFinite(value) ? value : null
      } else if (
        value === null ||
        typeof value === 'boolean' ||
        typeof value === 'string'
      ) {
        snapshot[key] = value
      }
    }

    console.info(
      `[NCO-DIAG] ${JSON.stringify({
        ...snapshot,
        schemaVersion: 1,
        event,
        timestamp: new Date().toISOString(),
        elapsedMs: Math.round(performance.now()),
      })}`
    )
  } catch {
    // Console failures must not alter the observed lifecycle.
  }
}

export function createOffsetDiagnostics(
  provider: string,
  tabId: number,
  video: HTMLVideoElement,
  getContentId: () => string | null
): OffsetDiagnostics {
  // A random suffix also distinguishes independently loaded page contexts.
  const generation = `${Date.now().toString(36)}-${++generationSequence}-${Math.random().toString(36).slice(2, 10)}`

  return {
    provider,
    generation,
    log: (event, fields) => {
      try {
        emitOffsetDiagnostic(event, {
          ...getDiagnosticVideoSnapshot(video),
          ...fields,
          provider,
          tabId,
          generation,
          contentId: getContentId(),
        })
      } catch {
        emitOffsetDiagnostic(event, {
          provider,
          tabId,
          generation,
          contentIdUnavailable: true,
        })
      }
    },
  }
}
