import type { NCOverlay } from '@/ncoverlay'
import type { VodKey } from '@/types/constants'

import { defineContentScript } from '#imports'
import { parse } from '@midra/nco-utils/parse'

import {
  inspectNetflixTimeline,
  selectNetflixTimelineSource,
} from '@/timeline-sync/providers/netflix'
import { MATCHES } from '@/constants/matches'
import { logger } from '@/utils/logger'
import { checkVodEnable } from '@/utils/extension/checkVodEnable'
import { ncoApiProxy } from '@/proxy/nco-utils/api/extension'
import { NCOPatcher } from '@/ncoverlay/patcher'

import './style.css'

const vod: VodKey = 'netflix'
const WATCH_ID_PATH_REGEXP = /^\/watch\/(\d+)\/?$/

function getWatchId(): number | null {
  const match = location.pathname.match(WATCH_ID_PATH_REGEXP)
  const id = match ? Number(match[1]) : NaN

  return Number.isSafeInteger(id) && id > 0 ? id : null
}

export default defineContentScript({
  matches: MATCHES[vod],
  runAt: 'document_end',
  main: () => void main(),
})

async function main() {
  if (!(await checkVodEnable(vod))) return

  logger.log('vod', vod)

  let metadataGeneration = 0
  let observedWatchId = getWatchId()
  let infoInvalidation: Promise<void> = Promise.resolve()
  const lifecycleInstances = new WeakSet<NCOverlay>()

  const invalidateInfo = (nco: NCOverlay) => {
    // Finish older removals before a new episode can commit its info.
    infoInvalidation = infoInvalidation
      .catch(() => {})
      .then(() => nco.state.remove('info'))

    return infoInvalidation
  }

  const patcher = new NCOPatcher(vod, {
    getInfo: async (nco, request) => {
      const generation = ++metadataGeneration
      const id = getWatchId()
      const video = nco.video

      const isCurrentRequest = () =>
        generation === metadataGeneration &&
        getWatchId() === id &&
        patcher.nco === nco &&
        nco.video === video

      request.isCurrent = isCurrentRequest

      if (id === null) {
        return null
      }

      if (observedWatchId !== id) {
        observedWatchId = id
        invalidateInfo(nco)
      }

      const assertCurrentRequest = () => {
        if (!isCurrentRequest()) {
          // Returning null would let Patcher erase a newer episode's info.
          throw new Error('Stale Netflix metadata response')
        }
      }

      await infoInvalidation
      assertCurrentRequest()

      const metadata = await ncoApiProxy.netflix.metadata(String(id))

      assertCurrentRequest()

      const selected = selectNetflixTimelineSource(metadata, id)

      if (!selected || !metadata) return null

      const { source, season, episode } = selected
      const inspection = inspectNetflixTimeline(source, id, video.duration)

      logger.log('netflix.providerTimeline', {
        providerTimeline: inspection.providerTimeline ?? null,
        diagnostics: inspection.diagnostics,
      })

      const subtitle = episode?.title || null

      const episodeNum = episode?.seq ?? -1

      const parsedSubtitle = parse(`タイトル ${subtitle}`)
      const subtitleEpisode =
        subtitle && parsedSubtitle.isSingleEpisode
          ? parsedSubtitle.episode
          : null

      const workTitle = season
        ? season.title.startsWith(metadata.title)
          ? season.title
          : `${metadata.title} ${season.title}`
        : metadata.title

      const episodeText =
        !subtitleEpisode && 0 <= episodeNum ? `第${episodeNum}話` : null
      const episodeTitle =
        [episodeText, subtitle].filter(Boolean).join(' ').trim() || null

      const duration =
        (episode?.runtime ?? metadata.runtime ?? nco.video.duration) - 10

      logger.log('workTitle', workTitle)
      logger.log('episodeTitle', episodeTitle)
      logger.log('duration', duration)

      return workTitle
        ? {
            input: `${workTitle} ${episodeTitle ?? ''}`,
            duration,
            providerTimeline: inspection.providerTimeline,
          }
        : null
    },
    appendCanvas: (video, canvas) => {
      const nco = patcher.nco

      if (nco && !lifecycleInstances.has(nco)) {
        lifecycleInstances.add(nco)

        const clear = nco.clear.bind(nco)
        const dispose = nco.dispose.bind(nco)

        nco.clear = (...args) => {
          metadataGeneration++
          return clear(...args)
        }
        nco.dispose = (...args) => {
          metadataGeneration++
          return dispose(...args)
        }
      }

      video.insertAdjacentElement('afterend', canvas)
    },
  })

  const obs_config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }
  const obs = new MutationObserver(async () => {
    obs.disconnect()

    const watchId = getWatchId()

    if (watchId !== observedWatchId) {
      observedWatchId = watchId
      metadataGeneration++

      if (patcher.nco) await invalidateInfo(patcher.nco)
    }

    if (patcher.nco) {
      if (!patcher.nco.video.checkVisibility()) {
        await patcher.dispose()
      }
    } else {
      if (location.pathname.startsWith('/watch/')) {
        const video = document.body.querySelector<HTMLVideoElement>(
          'div[data-uia="video-canvas"] video[src]'
        )

        if (video) {
          await patcher.setVideo(video)
        }
      }
    }

    obs.observe(document.body, obs_config)
  })

  obs.observe(document.body, obs_config)
}
