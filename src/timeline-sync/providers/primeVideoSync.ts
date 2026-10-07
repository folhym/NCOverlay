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
    readonly confirmedCumulativeInsertionMs: number | null
    readonly mediaCurrentTimeMs: number | null
    readonly previousMediaCurrentTimeMs: number | null
    readonly event: PrimeTimelineEvent
    readonly pendingBreakIndex: number | null
    readonly pendingCumulativeInsertionMs: number | null
    readonly candidateBreakIndices: readonly number[]
    readonly sourceBreakTimesMs: readonly number[]
    readonly alignments: readonly TimelineAlignment[]
  }
}

export type PrimeTimelineEvent =
  | 'initial'
  | 'durationchange'
  | 'timeupdate'
  | 'playing'
  | 'pause'
  | 'seeking'
  | 'seeked'

// A position tolerance for durationchange delivery, never an assumed ad length.
const POSITION_TOLERANCE_MS = 5000

/** One bound media/source session. A failed session stays disabled until reset. */
export class PrimeDurationTracker {
  readonly #breaks: PrimeAdBreaks
  readonly #alignments: TimelineAlignment[] = [
    { sourceTimeMs: 0, targetTimeMs: 0, reason: 'prime:start' },
  ]
  #cumulative: number | undefined
  #observedCumulative: number | undefined
  #previousTime: number | undefined
  #activeBreak: number | undefined
  #pendingBreak: number | undefined
  #preloaded = false
  #seeking = false
  #failure: string | undefined

  constructor(breaks: PrimeAdBreaks) {
    this.#breaks = breaks
  }

  sample(
    durationSeconds: number,
    currentTimeSeconds: number,
    event: PrimeTimelineEvent = 'durationchange'
  ): PrimeSyncSample {
    const rawDuration = durationSeconds * 1000
    const currentTime = currentTimeSeconds * 1000
    const duration =
      Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : null
    const cumulative =
      duration === null
        ? null
        : Math.round(duration - this.#breaks.fullTitleDurationMs)
    const previousTime = this.#previousTime
    let candidates: number[] = []
    const seek = event === 'seeking' || event === 'seeked'
    if (event === 'seeking') this.#seeking = true
    else if (event === 'seeked') this.#seeking = false

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
      } else if (cumulative < (this.#observedCumulative ?? this.#cumulative)) {
        this.#failure = 'duration-decreased'
      } else if (seek || this.#seeking) {
        this.#activeBreak = undefined
        if (this.#pendingBreak !== undefined || cumulative > this.#cumulative) {
          this.#failure = 'ambiguous-playback-seek'
        }
      } else if (cumulative > this.#cumulative) {
        const confirmed = this.#alignments.length - 1
        candidates = this.#candidates(currentTime, cumulative)
        const owner = candidates[0]
        const eligible = (index: number | undefined) =>
          index === confirmed ||
          (index === confirmed - 1 && index === this.#activeBreak)
        if (
          this.#pendingBreak === undefined &&
          confirmed < this.#breaks.sourceTimesMs.length &&
          previousTime !== undefined &&
          currentTime >= previousTime &&
          currentTime < this.#start(confirmed) &&
          (candidates.length === 0 ||
            (candidates.length === 1 && owner === confirmed))
        ) {
          if (!this.#uniquePreload(confirmed, cumulative)) {
            this.#failure = 'ambiguous-duration-growth'
          } else {
            // A normally advancing content clock can preload future ad duration.
            // Keep the latest cumulative amount pending until this break is reached.
            this.#pendingBreak = confirmed
            this.#preloaded = true
            this.#activeBreak = undefined
          }
        } else if (
          this.#preloaded &&
          !this.#uniquePreload(this.#pendingBreak!, cumulative)
        ) {
          this.#failure = 'ambiguous-duration-growth'
        } else if (
          candidates.length === 1 &&
          eligible(owner) &&
          (this.#pendingBreak === undefined || this.#pendingBreak === owner) &&
          // Preallocated duration is not applied before the actual mapped start,
          // even if the event's position falls within the old 5-second tolerance.
          (!this.#preloaded || currentTime >= this.#start(owner!))
        ) {
          const sourceTimeMs = this.#breaks.sourceTimesMs[owner!]!
          const alignment = {
            sourceTimeMs,
            targetTimeMs: sourceTimeMs + cumulative,
            reason: 'prime:ad-break',
          }
          if (owner === confirmed) this.#alignments.push(alignment)
          else this.#alignments[owner! + 1] = alignment
          this.#activeBreak = owner
          this.#pendingBreak = undefined
          this.#preloaded = false
          this.#cumulative = cumulative
        } else if (
          candidates.length === 0 ||
          (candidates.length === 1 &&
            owner === this.#pendingBreak &&
            this.#preloaded &&
            currentTime < this.#start(owner!))
        ) {
          // A reset/stale event clock may precede the growth. Require a unique
          // immediately preceding ownership sample; break count alone is not proof.
          const hint =
            this.#pendingBreak !== undefined
              ? [this.#pendingBreak]
              : previousTime === undefined
                ? []
                : this.#candidates(previousTime, this.#cumulative)
          const index = hint[0]
          if (
            hint.length === 1 &&
            eligible(index) &&
            currentTime <
              this.#start(index!) -
                (this.#preloaded ? 0 : POSITION_TOLERANCE_MS)
          ) {
            this.#pendingBreak = index
          } else this.#failure = 'ambiguous-duration-growth'
        } else this.#failure = 'ambiguous-duration-growth'
      } else if (
        this.#activeBreak !== undefined &&
        currentTime >
          this.#breaks.sourceTimesMs[this.#activeBreak]! +
            this.#cumulative +
            POSITION_TOLERANCE_MS
      ) {
        // Once ordinary media progress leaves this break, never reopen it using
        // a larger later duration. Subsequent growth must belong to the next break.
        this.#activeBreak = undefined
      }
      if (cumulative !== null) this.#observedCumulative = cumulative
      this.#previousTime =
        !seek &&
        !this.#seeking &&
        Number.isFinite(currentTime) &&
        currentTime >= 0
          ? currentTime
          : undefined
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
        reason:
          this.#failure ??
          (this.#pendingBreak === undefined
            ? 'duration-boundaries'
            : this.#preloaded
              ? 'preloaded-next-break'
              : 'awaiting-break-position'),
        breakCount: this.#breaks.sourceTimesMs.length,
        confirmedBreakCount: alignments.length ? alignments.length - 1 : 0,
        fullTitleDurationMs: this.#breaks.fullTitleDurationMs,
        mediaDurationMs: duration,
        cumulativeInsertionMs: cumulative,
        confirmedCumulativeInsertionMs: this.#failure
          ? null
          : (this.#cumulative ?? null),
        mediaCurrentTimeMs: Number.isFinite(currentTime) ? currentTime : null,
        previousMediaCurrentTimeMs: previousTime ?? null,
        event,
        pendingBreakIndex: this.#failure ? null : (this.#pendingBreak ?? null),
        pendingCumulativeInsertionMs:
          !this.#failure && this.#pendingBreak !== undefined
            ? cumulative
            : null,
        candidateBreakIndices: candidates,
        sourceBreakTimesMs: [...this.#breaks.sourceTimesMs],
        alignments,
      },
    }
  }

  #start(index: number) {
    const confirmed = this.#alignments.length - 1
    const prior =
      index < confirmed
        ? this.#alignments[index]!.targetTimeMs -
          this.#alignments[index]!.sourceTimeMs
        : this.#cumulative!
    return this.#breaks.sourceTimesMs[index]! + prior
  }

  #uniquePreload(index: number, cumulative: number) {
    const following = this.#breaks.sourceTimesMs[index + 1]
    // Reject insertion whose proposed ownership window overlaps another break.
    return (
      following === undefined ||
      this.#breaks.sourceTimesMs[index]! + cumulative + POSITION_TOLERANCE_MS <
        following + this.#cumulative! - POSITION_TOLERANCE_MS
    )
  }

  #candidates(currentTime: number, cumulative: number) {
    const confirmed = this.#alignments.length - 1
    return this.#breaks.sourceTimesMs.flatMap((source, index) => {
      const endOffset =
        index < confirmed && index !== this.#activeBreak
          ? this.#alignments[index + 1]!.targetTimeMs -
            this.#alignments[index + 1]!.sourceTimeMs
          : cumulative
      return this.#start(index) - POSITION_TOLERANCE_MS <= currentTime &&
        currentTime <= source + endOffset + POSITION_TOLERANCE_MS
        ? [index]
        : []
    })
  }
}
