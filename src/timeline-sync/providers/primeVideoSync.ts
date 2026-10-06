import type { ProviderTimeline, TimelineAlignment } from '@/timeline-sync/core'

import { sanitizePrimeTimelineEvidence } from './primeVideo'

export interface PrimeAdBreaks {
  readonly fullTitleDurationMs: number
  readonly sourceTimesMs: readonly number[]
}

/** Reject the whole playlist if a missing boundary could hide an earlier ad. */
export function findPrimeAdBreaks(evidence: unknown): PrimeAdBreaks | null {
  const diagnostics = sanitizePrimeTimelineEvidence(evidence)
  const { fullTitleDurationMs: duration, intraTitlePlaylist: entries } =
    diagnostics
  if (
    diagnostics.status !== 'captured' ||
    duration === null ||
    duration <= 0 ||
    entries[0]?.type !== 'Main' ||
    entries.at(-1)?.type !== 'Main'
  ) {
    return null
  }

  const sourceTimesMs: number[] = []
  let end = 0
  let remote = false
  for (const entry of entries) {
    if (entry.rangeStatus === 'invalid') return null
    if (entry.type === 'Remote') {
      // Consecutive Remotes form one break; their ranges are not ad lengths.
      remote = true
      continue
    }
    if (
      entry.type !== 'Main' ||
      entry.startMs !== end ||
      entry.endMs === null ||
      entry.endMs <= end ||
      entry.endMs > duration
    ) {
      return null
    }
    if (remote) sourceTimesMs.push(end)
    remote = false
    end = entry.endMs
  }
  return end === duration
    ? { fullTitleDurationMs: duration, sourceTimesMs }
    : null
}

export interface PrimeSyncSample {
  readonly providerTimeline?: ProviderTimeline
  readonly diagnostics: {
    readonly status: 'tracking' | 'disabled'
    readonly reason: string
    readonly breakCount: number
    readonly confirmedBreakCount: number
    readonly fullTitleDurationMs: number
    readonly mediaDurationMs: number | null
    readonly cumulativeInsertionMs: number | null
    readonly alignments: readonly TimelineAlignment[]
  }
}

// A position tolerance for durationchange delivery, never an assumed ad length.
const POSITION_TOLERANCE_MS = 5000

/** One bound media/source session. A failed session stays disabled until reset. */
export class PrimeDurationTracker {
  readonly #breaks: PrimeAdBreaks
  readonly #alignments: TimelineAlignment[] = [
    { sourceTimeMs: 0, targetTimeMs: 0, reason: 'prime:start' },
  ]
  #cumulative: number | undefined
  #failure: string | undefined

  constructor(breaks: PrimeAdBreaks) {
    this.#breaks = breaks
  }

  sample(durationSeconds: number, currentTimeSeconds: number): PrimeSyncSample {
    const rawDuration = durationSeconds * 1000
    const currentTime = currentTimeSeconds * 1000
    const duration =
      Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null
    const cumulative =
      duration === null
        ? null
        : Math.round(duration - this.#breaks.fullTitleDurationMs)

    if (!this.#failure) {
      if (
        duration === null ||
        !Number.isFinite(currentTime) ||
        currentTime < 0 ||
        currentTime > duration + POSITION_TOLERANCE_MS ||
        cumulative === null ||
        cumulative < 0 ||
        cumulative > this.#breaks.fullTitleDurationMs
      ) {
        this.#failure = 'invalid-media-sample'
      } else if (this.#cumulative === undefined) {
        if (cumulative !== 0) this.#failure = 'initial-insertion-unknown'
        else this.#cumulative = 0
      } else if (cumulative < this.#cumulative) {
        this.#failure = 'duration-decreased'
      } else if (cumulative > this.#cumulative) {
        const confirmed = this.#alignments.length - 1
        // A jump must correspond uniquely to the next unconfirmed boundary.
        // Including already confirmed breaks rejects chunked/preloaded updates.
        const candidates = this.#breaks.sourceTimesMs.flatMap(
          (source, index) => {
            const prior =
              index < confirmed
                ? this.#alignments[index]!.targetTimeMs -
                  this.#alignments[index]!.sourceTimeMs
                : this.#cumulative!
            return source + prior - POSITION_TOLERANCE_MS <= currentTime &&
              currentTime <= source + cumulative + POSITION_TOLERANCE_MS
              ? [index]
              : []
          }
        )
        if (candidates.length !== 1 || candidates[0] !== confirmed) {
          this.#failure = 'ambiguous-duration-growth'
        } else {
          const sourceTimeMs = this.#breaks.sourceTimesMs[confirmed]!
          this.#alignments.push({
            sourceTimeMs,
            targetTimeMs: sourceTimeMs + cumulative,
            reason: 'prime:ad-break',
          })
          this.#cumulative = cumulative
        }
      }
    }

    const alignments = this.#failure
      ? []
      : this.#alignments.map((alignment) => ({ ...alignment }))
    return {
      providerTimeline:
        !this.#failure && duration !== null
          ? { alignments, durationMs: duration }
          : undefined,
      diagnostics: {
        status: this.#failure ? 'disabled' : 'tracking',
        reason: this.#failure ?? 'duration-boundaries',
        breakCount: this.#breaks.sourceTimesMs.length,
        confirmedBreakCount: alignments.length ? alignments.length - 1 : 0,
        fullTitleDurationMs: this.#breaks.fullTitleDurationMs,
        mediaDurationMs: duration,
        cumulativeInsertionMs: cumulative,
        alignments,
      },
    }
  }
}
