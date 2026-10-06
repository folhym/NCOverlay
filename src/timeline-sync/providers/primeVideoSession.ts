import type { NCOverlay } from '@/ncoverlay'
import type { StateInfo } from '@/ncoverlay/state'
import type { ProviderTimeline } from '@/timeline-sync/core'

import equal from 'fast-deep-equal'

import { logger } from '@/utils/logger'

import { PrimeDurationTracker, findPrimeAdBreaks } from './primeVideoSync'

/** Prime-only listener/state ownership; shared Patcher and video events stay intact. */
export class PrimeVideoTimelineSession {
  readonly #nco: NCOverlay
  readonly #isOwner: () => boolean
  readonly #getContext: () => string | null
  #context: string | null
  #version = 0
  #active = false
  #disposed = false
  #source: string | undefined
  #tracker: PrimeDurationTracker | undefined
  #timeline: ProviderTimeline | undefined
  #initialTimeline: ProviderTimeline | undefined
  #expectedDuration = 0
  #infoIdentity: string | undefined
  #removeInfoListener: (() => void) | undefined
  #pending: Promise<void> = Promise.resolve()

  get version() {
    return this.#version
  }

  constructor(
    nco: NCOverlay,
    isOwner: () => boolean,
    getContext: () => string | null
  ) {
    this.#nco = nco
    this.#isOwner = isOwner
    this.#getContext = getContext
    this.#context = getContext()

    const clear = nco.clear.bind(nco)
    const dispose = nco.dispose.bind(nco)
    nco.clear = async (...args) => {
      // Keep private evidence only for a subsequently reverified same source.
      await this.pause(false, false)
      return clear(...args)
    }
    nco.dispose = async (...args) => {
      this.#disposed = true
      await this.pause(true, false)
      return dispose(...args)
    }
  }

  isCurrent(version: number) {
    return (
      !this.#disposed &&
      this.#version === version &&
      this.#isOwner() &&
      this.#matchesContext(this.#getContext())
    )
  }

  /** Synchronously invalidate reads; drain dispatched writes before clear/dispose. */
  pause(dropSource = false, stripTimeline = true) {
    const context = this.#getContext()
    const version = ++this.#version
    this.#active = false
    this.#nco.video.removeEventListener('durationchange', this.#durationChange)
    this.#removeInfoListener?.()
    this.#removeInfoListener = undefined
    this.#infoIdentity = undefined
    if (dropSource || !this.#matchesContext(context)) {
      this.#source = undefined
      this.#tracker = undefined
    }
    if (context !== null) this.#context = context
    if (stripTimeline) {
      this.#enqueue(async () => {
        const info = await this.#nco.state.get('info')
        if (!this.isCurrent(version) || !info?.providerTimeline) return
        await this.#nco.state.set('info', {
          ...info,
          providerTimeline: undefined,
        })
      })
    }
    return this.#pending
  }

  /** Compare complete contexts; transient DOM loss is not a source change. */
  checkContext() {
    const context = this.#getContext()
    if (context === null) return
    if (!this.#matchesContext(context)) void this.pause(true)
    else this.#context = context
  }

  #matchesContext(context: string | null) {
    // Keep the last valid context during controls/ad DOM reconstruction.
    return (
      context === null || this.#context === null || context === this.#context
    )
  }

  resume(id: string, evidence: unknown, enabled: boolean) {
    const breaks = enabled ? findPrimeAdBreaks(evidence) : null
    // IDs remain private ownership tokens; never log them.
    const source = breaks ? JSON.stringify([id, breaks]) : undefined
    if (!source || source !== this.#source) {
      // A newly confirmed metadata source establishes its own DOM baseline.
      // If its labels are hidden, do not compare their return to the old source.
      this.#context = this.#getContext()
      this.#source = source
      this.#tracker = breaks ? new PrimeDurationTracker(breaks) : undefined
    }
    this.#expectedDuration = Math.floor(
      (breaks?.fullTitleDurationMs ?? 0) / 1000
    )
    this.#sample()
    this.#initialTimeline = this.#timeline
    this.#active = !!this.#tracker
    if (this.#active) {
      this.#nco.video.addEventListener('durationchange', this.#durationChange)
      this.#removeInfoListener = this.#nco.state.onChange('info', (info) => {
        if (!info) {
          void this.pause(true, false)
          return
        }
        const identity = this.#identity(info)
        if (this.#infoIdentity === undefined) {
          // Wait for Patcher's PlayingInfo commit, rather than patching old info.
          if (
            info.duration !== this.#expectedDuration ||
            !equal(info.providerTimeline, this.#initialTimeline)
          ) {
            return
          }
          this.#infoIdentity = identity
        } else if (identity !== this.#infoIdentity) {
          void this.pause(true)
          return
        }
        if (!equal(info.providerTimeline, this.#timeline)) this.#updateInfo()
      })
    }
    return this.#initialTimeline
  }

  #identity(info: StateInfo) {
    return JSON.stringify([info.input, info.duration])
  }

  #enqueue(task: () => Promise<void>) {
    this.#pending = this.#pending
      .then(task)
      .catch((error) => logger.error('primeVideo.timelineSync', error))
  }

  #sample() {
    const sample = this.#tracker?.sample(
      this.#nco.video.duration,
      this.#nco.video.currentTime
    )
    this.#timeline = sample?.providerTimeline
    if (sample) logger.log('primeVideo.timelineSync', sample.diagnostics)
  }

  #durationChange = () => {
    this.checkContext()
    if (!this.#active || !this.isCurrent(this.#version)) return
    const previous = this.#timeline
    this.#sample()
    if (!equal(previous, this.#timeline)) this.#updateInfo()
  }

  #updateInfo() {
    const version = this.#version
    this.#enqueue(async () => {
      const info = await this.#nco.state.get('info')
      if (
        !this.#active ||
        !this.isCurrent(version) ||
        !info ||
        this.#identity(info) !== this.#infoIdentity ||
        equal(info.providerTimeline, this.#timeline)
      ) {
        return
      }
      // Preserve search input/duration/chapters and every other StateInfo field.
      await this.#nco.state.set('info', {
        ...info,
        providerTimeline: this.#timeline,
      })
    })
  }
}
