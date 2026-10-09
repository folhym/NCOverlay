import type { NCOverlay } from '@/ncoverlay'
import type { VodKey } from '@/types/constants'

import { defineContentScript } from '#imports'
import { parse } from '@midra/nco-utils/parse'
import { normalize } from '@midra/nco-utils/parse/libs/normalize'

import { inspectPrimeTimeline } from '@/timeline-sync/providers/primeVideo'
import { PrimeVideoMetadataReader } from '@/timeline-sync/providers/primeVideoMetadata'
import { PrimeVideoTimelineSession } from '@/timeline-sync/providers/primeVideoSession'
import { MATCHES } from '@/constants/matches'
import { logger } from '@/utils/logger'
import { sleep } from '@/utils/sleep'
import { checkVodEnable } from '@/utils/extension/checkVodEnable'
import { sendPageMessage } from '@/messaging/page'
import { NCOPatcher } from '@/ncoverlay/patcher'

import './style.css'

const vod: VodKey = 'primeVideo'

const SEASON_NUM_VAGUE_REGEXP = /(?<=[^\d]+)[2-9]$/

export default defineContentScript({
  matches: MATCHES[vod],
  runAt: 'document_end',
  main: () => void main(),
})

async function main() {
  if (!(await checkVodEnable(vod))) return

  logger.log('vod', vod)

  const sessions = new WeakMap<NCOverlay, PrimeVideoTimelineSession>()
  const metadataReaders = new WeakMap<NCOverlay, PrimeVideoMetadataReader>()
  // Only complete Episode context can identify a change. Controls/ads may
  // temporarily remove either element. Values are private, never logged.
  const getContext = () => {
    const title = document.body
      .querySelector(
        '.dv-player-fullscreen .atvwebplayersdk-title-text:not(:empty)'
      )
      ?.textContent?.trim()
    const subtitle = document.body
      .querySelector(
        '.dv-player-fullscreen :is(.atvwebplayersdk-subtitle-text, .atvwebplayersdk-episode-info)'
      )
      ?.textContent?.trim()
    return title && subtitle
      ? JSON.stringify([location.pathname, title, subtitle])
      : null
  }
  const getSession = (nco: NCOverlay) => {
    let session = sessions.get(nco)
    if (!session) {
      const video = nco.video
      session = new PrimeVideoTimelineSession(
        nco,
        () => patcher.nco === nco && nco.video === video,
        getContext
      )
      sessions.set(nco, session)
      metadataReaders.set(
        nco,
        new PrimeVideoMetadataReader(
          getContext,
          (signal) =>
            sendPageMessage('page:primeVideo:getPlaybackInfo', null, signal),
          sleep
        )
      )
    }
    return session
  }

  const patcher = new NCOPatcher(
    vod,
    {
      getInfo: async (nco, request) => {
        const session = getSession(nco)
        return metadataReaders
          .get(nco)!
          .load(session, request, (playbackInfo) => {
            const inspection = inspectPrimeTimeline(
              playbackInfo?.timelineEvidence,
              nco.video.duration,
              nco.video.currentTime
            )
            logger.log('primeVideo.timelineEvidence', inspection.diagnostics)

            const { playbackUrls, catalog } = playbackInfo

            const title = catalog.seriesTitle || catalog.title
            const subtitle = catalog.seriesTitle ? catalog.title : null

            const seasonNum = catalog.seasonNumber ?? -1
            const episodeNum = catalog.episodeNumber ?? -1

            const seasonNumVague = Number(
              normalize(title).match(SEASON_NUM_VAGUE_REGEXP)?.[0] ?? -1
            )

            const parsedSubtitle = parse(`タイトル ${subtitle}`)
            const titleSeason = parse(`${title} #0`).season
            const subtitleEpisode =
              subtitle && parsedSubtitle.isSingleEpisode
                ? parsedSubtitle.episode
                : null

            const seasonText =
              !titleSeason && 2 <= seasonNum && seasonNum !== seasonNumVague
                ? `第${seasonNum}期`
                : null
            const workTitle =
              [title, seasonText].filter(Boolean).join(' ').trim() || null

            const episodeText =
              !subtitleEpisode && 0 <= episodeNum ? `第${episodeNum}話` : null
            const episodeTitle =
              [episodeText, subtitle].filter(Boolean).join(' ').trim() || null

            const duration = playbackUrls.fullTitleDurationMs / 1000

            logger.log('workTitle', workTitle)
            logger.log('episodeTitle', episodeTitle)
            logger.log('duration', duration)

            const providerTimeline = session.resume(
              playbackInfo.id,
              playbackInfo.timelineEvidence,
              // Playback observations cover Episodes; movies retain the normal pipeline.
              catalog.type === 'EPISODE' &&
                !!catalog.seriesTitle &&
                Number.isSafeInteger(catalog.seasonNumber) &&
                Number.isSafeInteger(catalog.episodeNumber) &&
                seasonNum >= 0 &&
                episodeNum >= 0
            )

            return workTitle
              ? {
                  input: `${workTitle} ${episodeTitle ?? ''}`,
                  duration,
                  providerTimeline,
                }
              : null
          })
          .catch((error) => {
            logger.log(
              'primeVideo.timelineEvidence',
              inspectPrimeTimeline(
                undefined,
                nco.video.duration,
                nco.video.currentTime
              ).diagnostics
            )
            throw error
          })
      },
      appendCanvas: (video, canvas) => {
        if (patcher.nco) getSession(patcher.nco)
        video
          .closest('.dv-player-fullscreen')
          ?.querySelector('.atvwebplayersdk-player-container')
          ?.insertAdjacentElement('afterbegin', canvas)
      },
    },
    { canvasDiagnostics: true, pipelineDiagnostics: true }
  )

  const obs_config: MutationObserverInit = {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src'],
  }
  const obs = new MutationObserver(async () => {
    obs.disconnect()

    if (patcher.nco) {
      getSession(patcher.nco).checkContext()
      if (!patcher.nco.video.checkVisibility()) {
        await patcher.dispose()
      }
    } else {
      const video = document.body.querySelector<HTMLVideoElement>(
        '.dv-player-fullscreen video[src]'
      )

      if (video) {
        await patcher.setVideo(video)
      }
    }

    obs.observe(document.body, obs_config)
  })

  obs.observe(document.body, obs_config)
}
