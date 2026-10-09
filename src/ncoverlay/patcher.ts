import type { ParsedResult } from '@midra/nco-utils/parse'
import type { ProviderTimeline } from '@/timeline-sync/core'
import type { VodKey } from '@/types/constants'
import type { VideoChapter } from '@/utils/api/jikkyo/findChapters'
import type { NCOSearcherAutoSearchArgs } from './searcher'
import type { StateFileDetail, StateInfo } from './state'

import { parse } from '@midra/nco-utils/parse'

import { filterAutomaticSearchTargets } from '@/timeline-sync/sourcePolicy'
import { logger } from '@/utils/logger'
import { settings } from '@/utils/settings/extension'
import { sendExtensionMessage } from '@/messaging/extension'

import { NCOverlay } from '.'

export interface PlayingInfo {
  input: string | ParsedResult
  duration: number
  chapters?: VideoChapter[]
  /** Confirmed anchors or direct mappings into Renderer's media clock; no wall time. */
  providerTimeline?: ProviderTimeline
  disableParse?: boolean
  disableAdjustJikkyoOffset?: boolean
  isNhkOndemand?: boolean
}

export interface NCOPatcherInit {
  getInfo: (
    nco: NCOverlay,
    request: NCOPatcherInfoRequest
  ) => Promise<PlayingInfo | null>
  appendCanvas: (video: HTMLVideoElement, canvas: HTMLCanvasElement) => void
  autoSearch?: (
    nco: NCOverlay,
    args: NCOSearcherAutoSearchArgs & StateInfo
  ) => Promise<void>
}

export interface NCOPatcherInfoRequest {
  /** Optional provider check immediately before committing even a null result. */
  isCurrent?: () => boolean
}

export interface NCOPatcherFunctions {
  getCurrentTime?: () => number
  /** Opt-in numeric canvas lifecycle diagnostics; no frame-by-frame logging. */
  canvasDiagnostics?: boolean
  /** Opt-in sanitized metadata/search/load stages. */
  pipelineDiagnostics?: boolean
}

export class NCOPatcher {
  readonly #vod
  readonly #init
  readonly #functions

  #tabId: number | null = null
  #video: HTMLVideoElement | null = null
  #nco: NCOverlay | null = null
  #videoGeneration = 0

  get nco() {
    return this.#nco
  }

  constructor(
    vod: VodKey,
    init: NCOPatcherInit,
    functions?: NCOPatcherFunctions
  ) {
    logger.log('new NCOPatcher()')

    this.#vod = vod
    this.#init = init
    this.#functions = functions
  }

  async dispose() {
    this.#videoGeneration++
    logger.log('NCOPatcher.dispose()')

    await this.#nco?.dispose()

    this.#video = null
    this.#nco = null
  }

  async setVideo(
    video: HTMLVideoElement,
    fileDetail: StateFileDetail | null = null
  ) {
    if (this.#video === video) return
    const ownerGeneration = ++this.#videoGeneration

    logger.log('NCOPatcher.setVideo()')

    this.#video = video

    if (this.#tabId === null) {
      const tab = await sendExtensionMessage('bg:getCurrentTab', null)

      this.#tabId = tab?.id!
    }

    if (ownerGeneration !== this.#videoGeneration) return
    await this.#nco?.dispose()
    if (ownerGeneration !== this.#videoGeneration) return

    this.#nco = new NCOverlay(this.#tabId, video, this.#functions)
    const nco = this.#nco
    let infoGeneration = 0
    let pendingWrite: Promise<unknown> = Promise.resolve()
    const isCurrent = (generation: number) =>
      ownerGeneration === this.#videoGeneration &&
      this.#nco === nco &&
      generation === infoGeneration
    // Drain dispatched state writes/cleanup before the next metadata commit.
    const write = (generation: number, task: () => Promise<unknown>) => {
      const result = pendingWrite.then(() =>
        isCurrent(generation) ? task() : undefined
      )
      pendingWrite = result.catch(() => {})
      return result
    }
    const trace = (event: string, generation: number) => {
      if (this.#functions?.pipelineDiagnostics) {
        logger.log('nco.commentPipeline', {
          event,
          ownerGeneration,
          generation,
          current: isCurrent(generation),
        })
      }
    }

    this.#nco.state.set('vod', this.#vod)
    this.#nco.state.set('fileDetail', fileDetail)

    const loadInfo = async (generation: number) => {
      if (!isCurrent(generation)) return false
      trace('getInfo.start', generation)

      logger.log('NCOPatcher.setVideo > loadInfo()')

      try {
        const request: NCOPatcherInfoRequest = {}
        const info = await this.#init.getInfo(nco, request)

        if (
          !isCurrent(generation) ||
          (request.isCurrent && !request.isCurrent())
        ) {
          trace('getInfo.stale', generation)
          return false
        }

        let parsed: ParsedResult | undefined

        if (info) {
          const { input } = info

          if (info.disableParse) {
            parsed =
              typeof input === 'string'
                ? {
                    ...parse(''),
                    input: input,
                    title: input,
                    titleStripped: input,
                  }
                : input
          } else {
            parsed = parse(input)
          }
        }

        const args: StateInfo = {
          input: parsed ?? '',
          duration: info ? Math.floor(info.duration) : 0,
          chapters: info?.chapters,
          providerTimeline: info?.providerTimeline,
          disableAdjustJikkyoOffset: info?.disableAdjustJikkyoOffset,
          isNhkOndemand: info?.isNhkOndemand,
        }

        let accepted = false
        await write(generation, () => {
          if (request.isCurrent && !request.isCurrent())
            return Promise.resolve()
          accepted = true
          return nco.state.set('info', args)
        })
        if (!accepted || !isCurrent(generation)) return false
        trace('getInfo.accepted', generation)

        logger.log('state.info', args)
        return true
      } catch (err) {
        trace('getInfo.error', generation)
        logger.error('NCOPatcher.setVideo > loadInfo()', err)
        return false
      }
    }

    const autoSearch = async (generation: number) => {
      if (!isCurrent(generation)) return

      logger.log('NCOPatcher.setVideo > autoSearch()')

      const status = await nco.state.get('status')
      if (!isCurrent(generation)) return

      if (status === 'searching' || status === 'loading') {
        trace('search.busy', generation)
        return
      }

      await write(generation, () => nco.state.set('status', 'searching'))
      trace('search.start', generation)

      try {
        const info = await nco.state.get('info')

        const [targets, jikkyoChannelIds, jikkyoIgnoreRerun] =
          await settings.get(
            'autoSearch:targets',
            'autoSearch:jikkyoChannelIds',
            'autoSearch:jikkyoIgnoreRerun'
          )
        if (!isCurrent(generation)) return

        const args: (NCOSearcherAutoSearchArgs & StateInfo) | null = {
          input: '',
          duration: 0,
          targets,
          jikkyoChannelIds,
          jikkyoIgnoreRerun,
          ...info,
        }

        // Filter after info overrides so custom automatic searchers share the policy.
        args.targets = filterAutomaticSearchTargets(args.targets)

        // 自動検索
        if (args.targets.length && args.input && args.duration) {
          if (this.#init.autoSearch) {
            await this.#init.autoSearch(nco, args)
          } else {
            await nco.searcher.autoSearch(args)
          }
        }
      } catch (err) {
        trace('search.error', generation)
        logger.error('NCOPatcher.setVideo > autoSearch()', err)
      }

      await write(generation, () => nco.state.set('status', 'ready'))
      trace('search.complete', generation)
    }

    let prev: number | null = null

    nco.addEventListener('loadedmetadata', async function () {
      const now = performance.now()
      const isSkip = prev !== null && now - prev < 1000

      prev = now

      if (isSkip) return

      const generation = ++infoGeneration
      trace('loadedmetadata', generation)
      await write(generation, () => nco.clear())

      if (!(await loadInfo(generation))) return

      if (await settings.get('autoSearch:manual')) return

      await autoSearch(generation)
    })

    nco.addEventListener('reload', async function () {
      const generation = ++infoGeneration
      trace('reload', generation)
      await write(generation, async () => {
        await nco.searcher.cancel()
        await this.state.remove('status')
        await this.state.remove('slots', { isAutoLoaded: true })
        await this.state.remove('slotDetails', { isAutoLoaded: true })
      })

      if (!(await loadInfo(generation))) return
      await autoSearch(generation)
    })

    const intervalMs = 250
    let lastTime = performance.now()

    this.#nco.addEventListener('timeupdate', function () {
      const time = performance.now()
      const delta = time - lastTime

      if (intervalMs < delta) {
        lastTime = time - (delta % intervalMs)

        sendExtensionMessage('bg:timeupdate', {
          id: this.id,
          time: this.renderer.getCurrentTime() * 1000,
        })
      }
    })

    this.#init.appendCanvas(this.#nco.video, this.#nco.canvas)
  }
}
