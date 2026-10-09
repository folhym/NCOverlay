import type { GetDataType } from '@webext-core/messaging'
import type { DAnimePlaybackInfo } from '@/entrypoints/page-dAnime.content'
import type { PrimeVideoPlaybackInfo } from '@/entrypoints/page-primeVideo.content'
import type { UnextPlaybackInfo } from '@/entrypoints/page-unext.content'
import type { setBadge } from '@/utils/extension/setBadge'

import { defineCustomEventMessaging } from '@webext-core/messaging/page'

export interface ProtocolMap {
  // page -> content
  'content:setBadge': (
    args: Parameters<typeof setBadge>[0]
  ) => Awaited<ReturnType<typeof setBadge>>

  // content -> page
  'page:primeVideo:getPlaybackInfo': (
    args?: null
  ) => PrimeVideoPlaybackInfo | null
  'page:unext:getPlaybackInfo': (args?: null) => UnextPlaybackInfo | null
  'page:dAnime:getPlaybackInfo': (args?: null) => DAnimePlaybackInfo | null
}

const { sendMessage: sendSharedPageMessage, onMessage: onPageMessage } =
  defineCustomEventMessaging<ProtocolMap>({
    namespace: `${EXT_BUILD_ID}:page`,
  })

/** A cancellable request gets its own listeners; abort never affects other callers. */
export function sendPageMessage<K extends keyof ProtocolMap>(
  type: K,
  data: GetDataType<ProtocolMap[K]>,
  signal?: AbortSignal
) {
  if (!signal) return sendSharedPageMessage(type, data)
  const aborted = () => new DOMException('Page request aborted', 'AbortError')
  if (signal.aborted) return Promise.reject(aborted())
  const scoped = defineCustomEventMessaging<ProtocolMap>({
    namespace: `${EXT_BUILD_ID}:page`,
  })
  let abort: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(aborted())
    signal.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([scoped.sendMessage(type, data), cancelled]).finally(
    () => {
      signal.removeEventListener('abort', abort!)
      scoped.removeAllListeners()
    }
  )
}

export { onPageMessage }
