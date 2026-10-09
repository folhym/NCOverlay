import type { PrimeVideoPlaybackInfo } from '@/entrypoints/page-primeVideo.content'
import type { NCOPatcherInfoRequest, PlayingInfo } from '@/ncoverlay/patcher'
import type { PrimeVideoTimelineSession } from './primeVideoSession'

import { logger } from '@/utils/logger'

export const PRIME_METADATA_ATTEMPTS = 3
const RESPONSE_TIMEOUT = Symbol('prime-metadata-timeout')

type Failure =
  | 'none'
  | 'owner-changed'
  | 'context-changed'
  | 'session-invalidated'
  | 'pause-failed'
  | 'settle-failed'
  | 'message-failed'
  | 'message-timeout'
  | 'metadata-missing'
  | 'metadata-invalid'
  | 'source-not-advanced'
  | 'parse-failed'
type Stage =
  | 'pause'
  | 'settle'
  | 'message'
  | 'validate'
  | 'parse'
  | 'accepted'
  | 'retry'
  | 'exhausted'
  | 'cancelled'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function validMetadata(value: unknown): value is PrimeVideoPlaybackInfo {
  const info = record(value),
    urls = record(info?.playbackUrls),
    catalog = record(info?.catalog)
  if (
    !info ||
    !urls ||
    !catalog ||
    typeof info.id !== 'string' ||
    !info.id.trim()
  )
    return false
  if (
    typeof urls.fullTitleDurationMs !== 'number' ||
    !Number.isFinite(urls.fullTitleDurationMs) ||
    urls.fullTitleDurationMs <= 0
  )
    return false
  const title = catalog.seriesTitle || catalog.title
  if (typeof title !== 'string' || !title.trim()) return false
  if (
    catalog.seriesTitle &&
    (typeof catalog.title !== 'string' || !catalog.title.trim())
  )
    return false
  for (const key of ['seasonNumber', 'episodeNumber']) {
    const number = catalog[key]
    if (number != null && !Number.isSafeInteger(number)) return false
  }
  if (
    catalog.type === 'EPISODE' &&
    (!Number.isSafeInteger(catalog.seasonNumber) ||
      !Number.isSafeInteger(catalog.episodeNumber) ||
      (catalog.seasonNumber as number) < 0 ||
      (catalog.episodeNumber as number) < 0)
  )
    return false
  return true
}

/** Prime-only, finite metadata recovery. IDs/context stay private, never logged. */
export class PrimeVideoMetadataReader {
  #previous: { id: string; context: string | null } | undefined
  #operations = new WeakMap<
    NCOPatcherInfoRequest,
    { used: number; generation: number }
  >()

  constructor(
    readonly getContext: () => string | null,
    readonly read: (signal: AbortSignal) => Promise<unknown>,
    readonly wait: (ms: number) => Promise<unknown>,
    readonly timeoutMs = 8000
  ) {}

  async load(
    session: PrimeVideoTimelineSession,
    request: NCOPatcherInfoRequest,
    parse: (info: PrimeVideoPlaybackInfo) => PlayingInfo | null
  ): Promise<PlayingInfo> {
    let operation = this.#operations.get(request)
    if (!operation) {
      operation = { used: 0, generation: session.metadataGeneration }
      this.#operations.set(request, operation)
    }
    const { generation } = operation
    const active = () =>
      request.isOwnerCurrent?.() !== false &&
      session.isMetadataOwner(generation)
    let version = session.version,
      context = this.getContext(),
      attempt = operation.used
    const trace = (stage: Stage, failure: Failure = 'none') => {
      const currentContext = this.getContext()
      logger.log('primeVideo.getInfo', {
        stage,
        failure,
        attempt,
        lifecycleGeneration: generation,
        sessionVersion: version,
        ownerCurrent: active(),
        sessionCurrent: session.isCurrent(version),
        contextKnown: currentContext !== null,
        contextChanged: currentContext !== context,
      })
    }
    const stale = (): Failure =>
      !active()
        ? 'owner-changed'
        : !session.isCurrent(version)
          ? this.getContext() !== context
            ? 'context-changed'
            : 'session-invalidated'
          : 'none'
    const stop = () => {
      request.failureLogged = true
      request.isCurrent = () => false
      throw new Error('Prime metadata unavailable')
    }
    // The same budget spans acquisition and Patcher's final async commit guard.
    request.retryOnStale = () => {
      const failure = stale()
      const retry = active() && operation.used < PRIME_METADATA_ATTEMPTS
      trace(!active() ? 'cancelled' : retry ? 'retry' : 'exhausted', failure)
      return retry
    }
    while (operation.used < PRIME_METADATA_ATTEMPTS) {
      attempt = ++operation.used
      if (!active()) {
        trace('cancelled', 'owner-changed')
        return stop()
      }
      let failure: Failure = 'none'
      try {
        const drained = session.pause()
        version = session.version
        context = this.getContext()
        request.isCurrent = () => active() && session.isCurrent(version)
        trace('pause')
        await drained
      } catch {
        failure = 'pause-failed'
      }
      if (!active()) {
        trace('cancelled', 'owner-changed')
        return stop()
      }
      if (failure === 'none') {
        trace('settle')
        try {
          await this.wait(2000)
        } catch {
          failure = 'settle-failed'
        }
      }
      if (failure === 'none') failure = stale()
      let info: unknown
      if (failure === 'none') {
        context = this.getContext()
        trace('message')
        const controller = new AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          info = await Promise.race([
            Promise.resolve().then(() => this.read(controller.signal)),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(RESPONSE_TIMEOUT), this.timeoutMs)
            }),
          ])
        } catch (error) {
          failure =
            error === RESPONSE_TIMEOUT ? 'message-timeout' : 'message-failed'
        } finally {
          controller.abort()
          clearTimeout(timer)
        }
        // Recheck even after a rejected message. A cancelled old request cannot retry.
        const changed = stale()
        if (changed !== 'none') failure = changed
        else if (this.getContext() !== context) failure = 'context-changed'
      }
      if (failure === 'none') {
        trace('validate')
        try {
          if (info == null) failure = 'metadata-missing'
          else if (!validMetadata(info)) failure = 'metadata-invalid'
          else if (
            this.#previous &&
            context !== null &&
            this.#previous.context !== null &&
            context !== this.#previous.context &&
            info.id === this.#previous.id
          )
            failure = 'source-not-advanced'
        } catch {
          failure = 'metadata-invalid'
        }
      }
      if (failure === 'none') {
        trace('parse')
        try {
          const result = parse(info as PrimeVideoPlaybackInfo)
          if (!result) failure = 'parse-failed'
          else {
            failure = stale()
            if (failure === 'none') {
              const metadata = info as PrimeVideoPlaybackInfo
              this.#previous = { id: metadata.id, context }
              trace('accepted')
              return result
            }
          }
        } catch {
          failure = 'parse-failed'
        }
      }
      if (!active()) failure = 'owner-changed'
      if (failure === 'owner-changed') {
        trace('cancelled', failure)
        return stop()
      }
      trace(attempt < PRIME_METADATA_ATTEMPTS ? 'retry' : 'exhausted', failure)
    }
    return stop()
  }
}
