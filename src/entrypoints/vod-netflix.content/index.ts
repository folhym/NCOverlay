import type {
  Episode,
  Season,
} from '@midra/nco-utils/types/api/netflix/metadata'
import type { VodKey } from '@/types/constants'
import type {
  OffsetDiagnosticFields,
  OffsetDiagnostics,
} from '@/utils/offsetDiagnostics'

import { defineContentScript } from '#imports'
import { parse } from '@midra/nco-utils/parse'

import { MATCHES } from '@/constants/matches'
import { logger } from '@/utils/logger'
import {
  emitOffsetDiagnostic,
  getDiagnosticVideoSnapshot,
} from '@/utils/offsetDiagnostics'
import { checkVodEnable } from '@/utils/extension/checkVodEnable'
import { ncoApiProxy } from '@/proxy/nco-utils/api/extension'
import { NCOPatcher } from '@/ncoverlay/patcher'

import './style.css'

const vod: VodKey = 'netflix'
const CONTENT_ID_REGEXP = /^\/watch\/(\d+)(?:\/)?$/

function getContentId() {
  return location.pathname.match(CONTENT_ID_REGEXP)?.[1] ?? null
}

function diagnosticNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export default defineContentScript({
  matches: MATCHES[vod],
  runAt: 'document_end',
  main: () => void main(),
})

async function main() {
  if (!(await checkVodEnable(vod))) return

  logger.log('vod', vod)

  const patcher = new NCOPatcher(vod, {
    diagnostics: { getContentId },
    getInfo: async (nco) => {
      const id = location.pathname.split('/').at(-1)
      const requestedContentId = getContentId()

      nco.diagnostics?.log('netflix:metadata-request', {
        requestedContentId,
        requestIdAvailable: Boolean(id),
      })

      if (!id) {
        return null
      }

      const metadata = await ncoApiProxy.netflix.metadata(id)

      nco.diagnostics?.log('netflix:metadata-response', {
        requestedContentId,
        responseContentId: getContentId(),
        available: Boolean(metadata),
        metadataVideoId: diagnosticNumber(metadata?.id),
        metadataCurrentEpisode: diagnosticNumber(metadata?.currentEpisode),
        metadataRuntime: diagnosticNumber(metadata?.runtime),
      })

      if (!metadata) {
        return null
      }

      let season: Season | undefined
      let episode: Episode | undefined

      if (metadata.seasons) {
        const episodeId = Number(id)

        for (const szn of metadata.seasons) {
          const ep = szn.episodes.find((ep) => ep.id === episodeId)

          if (ep) {
            season = szn
            episode = ep

            break
          }
        }

        if (!season || !episode) {
          nco.diagnostics?.log('netflix:metadata-selection', {
            requestedContentId,
            episodeFound: false,
            selectedEpisodeId: null,
            selectedEpisodeAlternateId: null,
            selectedEpisodeRuntime: null,
          })

          return null
        }
      }

      nco.diagnostics?.log('netflix:metadata-selection', {
        requestedContentId,
        episodeFound: Boolean(episode),
        selectedEpisodeId: diagnosticNumber(episode?.id),
        selectedEpisodeAlternateId: diagnosticNumber(episode?.episodeId),
        selectedEpisodeRuntime: diagnosticNumber(episode?.runtime),
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

      nco.diagnostics?.log('netflix:metadata-duration', {
        requestedContentId,
        episodeRuntime: diagnosticNumber(episode?.runtime),
        metadataRuntime: diagnosticNumber(metadata.runtime),
        videoDuration: diagnosticNumber(nco.video.duration),
        duration: diagnosticNumber(duration),
      })

      logger.log('workTitle', workTitle)
      logger.log('episodeTitle', episodeTitle)
      logger.log('duration', duration)

      return workTitle
        ? {
            input: `${workTitle} ${episodeTitle ?? ''}`,
            duration,
          }
        : null
    },
    appendCanvas: (video, canvas) => {
      video.insertAdjacentElement('afterend', canvas)
    },
  })

  const obs_config: MutationObserverInit = {
    childList: true,
    subtree: true,
  }
  let observerState: string | null = null
  let lastObserverLogTime = 0
  let pendingMutationCallbacks = 0
  let pendingMutationRecords = 0

  function logObserverMutation(
    records: MutationRecord[],
    diagnostics: OffsetDiagnostics | undefined,
    fields: OffsetDiagnosticFields
  ) {
    pendingMutationCallbacks++
    pendingMutationRecords += records.length

    const contentId = getContentId()
    const state = JSON.stringify({
      contentId,
      generation: diagnostics?.generation ?? null,
      hasInstance: fields.hasInstance,
      videoId: fields.videoId,
      srcRevision: fields.srcRevision,
      currentSrcRevision: fields.currentSrcRevision,
      visible: fields.visible,
      candidateVideoId: fields.candidateVideoId,
      candidateSrcRevision: fields.candidateSrcRevision,
      candidateCurrentSrcRevision: fields.candidateCurrentSrcRevision,
    })
    const now = performance.now()
    const changed = state !== observerState

    if (!changed && now - lastObserverLogTime < 5000) return

    const event = changed
      ? 'netflix:observer-state'
      : 'netflix:observer-summary'
    const details = {
      contentId,
      ...fields,
      mutationCallbacks: pendingMutationCallbacks,
      mutationRecords: pendingMutationRecords,
      suppressedCallbacks: pendingMutationCallbacks - 1,
    }

    if (diagnostics) {
      diagnostics.log(event, details)
    } else {
      emitOffsetDiagnostic(event, {
        provider: vod,
        generation: null,
        ...details,
      })
    }

    observerState = state
    lastObserverLogTime = now
    pendingMutationCallbacks = 0
    pendingMutationRecords = 0
  }

  const obs = new MutationObserver(async (records) => {
    obs.disconnect()

    if (patcher.nco) {
      const nco = patcher.nco
      const visible = nco.video.checkVisibility()

      logObserverMutation(records, nco.diagnostics, {
        ...getDiagnosticVideoSnapshot(nco.video),
        hasInstance: true,
        visible,
        candidateVideoId: null,
        candidateSrcRevision: null,
        candidateCurrentSrcRevision: null,
      })

      if (!visible) {
        nco.diagnostics?.log('netflix:dispose-request', {
          reason: 'video-not-visible',
        })

        await patcher.dispose()
      }
    } else {
      let candidateVideo: HTMLVideoElement | null = null

      if (location.pathname.startsWith('/watch/')) {
        const video = document.body.querySelector<HTMLVideoElement>(
          'div[data-uia="video-canvas"] video[src]'
        )

        candidateVideo = video
      }

      const candidateSnapshot = candidateVideo
        ? getDiagnosticVideoSnapshot(candidateVideo)
        : null

      logObserverMutation(records, undefined, {
        hasInstance: false,
        videoId: null,
        srcRevision: null,
        visible: null,
        candidateVideoId: candidateSnapshot?.videoId ?? null,
        candidateSrcRevision: candidateSnapshot?.srcRevision ?? null,
        candidateCurrentSrcRevision:
          candidateSnapshot?.currentSrcRevision ?? null,
      })

      if (candidateVideo) {
        await patcher.setVideo(candidateVideo)
      }
    }

    obs.observe(document.body, obs_config)
  })

  obs.observe(document.body, obs_config)

  emitOffsetDiagnostic('netflix:observer-registered', {
    provider: vod,
    generation: null,
    contentId: getContentId(),
    childList: true,
    subtree: true,
    attributes: false,
  })
}
