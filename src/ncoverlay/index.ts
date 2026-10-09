import type { MarkerKey } from '@/constants/markers'
import type { Browser } from '@/utils/webext'
import type { NCOPatcherFunctions } from './patcher'
import type { NcoThreadsV1Thread } from './state'

import equal from 'fast-deep-equal'

import { MARKERS } from '@/constants/markers'
import { SLOTS_REFRESH_SETTINGS_KEYS } from '@/constants/settings'
import { logger } from '@/utils/logger'
import { webext } from '@/utils/webext'
import { settings } from '@/utils/settings/extension'
import { onExtensionMessage, sendExtensionMessage } from '@/messaging/extension'

import { NCOKeyboard } from './keyboard'
import { NCORenderer } from './renderer'
import { NCOSearcher } from './searcher'
import { NCOState } from './state'

import './style.css'

export interface NCOverlayEventMap {
  playing: (this: NCOverlay) => void
  pause: (this: NCOverlay) => void
  seeked: (this: NCOverlay) => void
  timeupdate: (this: NCOverlay) => void
  loadedmetadata: (this: NCOverlay) => void

  reload: (this: NCOverlay) => void
}

/**
 * NCOverlay
 */
export class NCOverlay {
  readonly id: number
  readonly state: NCOState
  readonly searcher: NCOSearcher
  readonly renderer: NCORenderer
  readonly keyboard: NCOKeyboard

  readonly #removeListenerCallbacks: (() => void)[] = []
  readonly #port: Browser.runtime.Port

  #threadRevision = 0
  #clearing = 0
  #disposed = false
  #renderedThreads: NcoThreadsV1Thread[] | null = null
  #pipelineDiagnostics = false

  get video() {
    return this.renderer.video
  }
  get canvas() {
    return this.renderer.canvas
  }

  constructor(
    tabId: number,
    video: HTMLVideoElement,
    functions?: NCOPatcherFunctions
  ) {
    logger.log('new NCOverlay()')
    this.#pipelineDiagnostics = functions?.pipelineDiagnostics ?? false

    this.id = tabId
    this.state = new NCOState(this.id)
    this.searcher = new NCOSearcher(this.state, functions?.pipelineDiagnostics)
    this.renderer = new NCORenderer(video, functions)
    this.keyboard = new NCOKeyboard(this.state, {
      jumpMarker: (...args) => this.jumpMarker(...args),
    })

    this.#port = webext.runtime.connect({ name: 'instance' })
    this.#port.onMessage.addListener((message) => {
      if (message === 'ping') {
        this.#port.postMessage(`pong:${this.id}`)
      }
    })

    this.#registerEventListener()

    sendExtensionMessage('bg:setBadge', { text: null })

    // 既にメタデータ読み込み済みの場合
    if (HTMLMediaElement.HAVE_METADATA <= this.video.readyState) {
      setTimeout(() => {
        this.#trigger('loadedmetadata')
      }, 100)
    }
  }

  async dispose() {
    if (this.#disposed) return
    this.#disposed = true
    logger.log('NCOverlay.dispose()')

    this.#threadRevision++
    this.renderer.dispose()
    this.#renderedThreads = null
    await this.searcher.cancel()
    await this.state.dispose()
    this.#threadRevision++
    this.keyboard.dispose()

    this.#port.disconnect()

    this.#unregisterEventListener()
    this.removeAllEventListeners()

    await sendExtensionMessage('bg:setBadge', { text: null })
  }

  async clear() {
    if (this.#disposed) return
    logger.log('NCOverlay.clear()')

    this.#threadRevision++
    this.#clearing++
    this.renderer.clear()
    this.#renderedThreads = null
    try {
      await this.searcher.cancel()
      await this.state.clear()
    } finally {
      this.#threadRevision++
      this.#clearing--
    }

    await sendExtensionMessage('bg:setBadge', { text: null })
  }

  /**
   * 指定したマーカーの位置にジャンプ
   */
  async jumpMarker(key: MarkerKey | null) {
    logger.log('NCOverlay.jumpMarker()', key)

    const oldDetails = await this.state.get('slotDetails')
    const newDetails = structuredClone(oldDetails)

    if (key === null) {
      if (newDetails) {
        for (const detail of newDetails) {
          delete detail.offsetMs
        }
      }
    } else {
      const markerIdx = MARKERS.findIndex((v) => v.key === key)

      const currentTimeMs = Math.trunc(this.renderer.getCurrentTime() * 1000)

      if (newDetails) {
        const adjustJikkyoOffset = await settings.get(
          'comment:adjustJikkyoOffset'
        )

        for (const detail of newDetails) {
          if (
            detail.type !== 'jikkyo' ||
            (adjustJikkyoOffset && detail.chapters.length)
          ) {
            continue
          }

          const marker = detail.markers[markerIdx]

          if (marker) {
            detail.offsetMs = currentTimeMs - marker
          }
        }
      }

      await this.state.remove('offset')
    }

    await this.state.set('slotDetails', newDetails)
  }

  /**
   * 描画するコメントデータを更新する
   */
  #updateRendererThreads = () => this.#refreshRendererThreads(false)

  #refreshRendererThreads = async (timelineOnly: boolean) => {
    if (this.#disposed || this.#clearing) {
      this.#traceThreads('blocked')
      return
    }
    const revision = ++this.#threadRevision
    const threads = await this.state.getThreads()

    if (this.#disposed || this.#clearing || revision !== this.#threadRevision) {
      this.#traceThreads('stale')
      return
    }
    // Timeline duration/pending evidence may change without changing displayed
    // comments. Do not create/destroy GPU surfaces for an identical result.
    if (timelineOnly && equal(threads, this.#renderedThreads)) return

    this.renderer.setThreads(threads)
    this.renderer.reload()
    this.#renderedThreads = threads
    this.#traceThreads('accepted', threads?.length ?? 0)
  }

  #traceThreads(event: 'blocked' | 'stale' | 'accepted', count = 0) {
    if (this.#pipelineDiagnostics) {
      logger.log('nco.rendererThreads', {
        event,
        revision: this.#threadRevision,
        clearing: this.#clearing,
        disposed: this.#disposed,
        count,
      })
    }
  }

  /**
   * イベントリスナー
   */
  #videoEventListeners: {
    [P in keyof HTMLVideoElementEventMap]?: (evt: Event) => void
  } = {
    loadedmetadata: () => {
      logger.log('event', 'loadedmetadata')

      this.#trigger('loadedmetadata')
    },

    playing: () => {
      this.renderer.start()

      this.#trigger('playing')
    },

    pause: () => {
      this.renderer.stop()

      this.#trigger('pause')
    },

    seeked: () => {
      this.renderer.rerender()

      this.#trigger('seeked')
    },

    timeupdate: () => {
      this.#trigger('timeupdate')
    },

    ratechange: () => {
      this.renderer.updateTime()
    },
  }

  /**
   * イベント登録
   */
  #registerEventListener() {
    // Video要素
    for (const key in this.#videoEventListeners) {
      const type = key as keyof HTMLVideoElementEventMap
      const listener = this.#videoEventListeners[type]!

      this.video.addEventListener(type, listener)
    }

    for (const key of SLOTS_REFRESH_SETTINGS_KEYS) {
      this.#removeListenerCallbacks.push(
        settings.onChange(key, this.#updateRendererThreads)
      )
    }

    // ストレージの監視
    this.#removeListenerCallbacks.push(
      // 設定 (コメント:表示サイズ)
      settings.watch('comment:scale', (scale) => {
        this.renderer.setOptions({
          scale: scale / 100,
          keepCA: scale !== 100,
        })

        this.renderer.reload()
      }),

      // 設定 (コメント:不透明度)
      settings.watch('comment:opacity', (opacity) => {
        this.renderer.setOpacity(opacity / 100)
      }),

      // 設定 (コメント:フレームレート)
      settings.watch('comment:fps', (fps) => {
        this.renderer.setFps(fps)
      }),

      // 検索ステータス
      this.state.onChange('status', (status) => {
        if ((status === 'ready' || status === 'error') && !this.video.paused) {
          this.renderer.start()
        }
      }),

      // 全体のオフセット
      this.state.onChange('offset', (offset) => {
        this.renderer.setOffset(offset ?? 0)
      }),

      // スロット
      this.state.onChange('slots', this.#updateRendererThreads),

      // Provider timeline changes also refresh manually added eligible slots.
      this.state.onChange('info', (newValue, oldValue) => {
        if (!equal(newValue?.providerTimeline, oldValue?.providerTimeline)) {
          this.#refreshRendererThreads(true)
        }
      }),

      // スロットの情報
      this.state.onChange('slotDetails', (newValue, oldValue) => {
        const newVal = newValue?.map((val) => ({
          id: val.id,
          status: val.status,
          offsetMs: val.offsetMs,
          translucent: val.translucent,
          hidden: val.hidden,
          skip: val.skip,
        }))
        const oldVal = oldValue?.map((val) => ({
          id: val.id,
          status: val.status,
          offsetMs: val.offsetMs,
          translucent: val.translucent,
          hidden: val.hidden,
          skip: val.skip,
        }))

        if (!equal(newVal, oldVal)) {
          this.#updateRendererThreads()

          // バッジ
          const displayedSlotDetails =
            newVal?.filter((v) => !v.hidden && !v.skip) ?? []

          const loadingCounts = displayedSlotDetails.filter(
            (detail) => detail.status === 'loading'
          ).length
          const successCounts = displayedSlotDetails.filter(
            (detail) => detail.status === 'ready'
          ).length
          const errorCounts = displayedSlotDetails.filter(
            (detail) => detail.status === 'error'
          ).length

          sendExtensionMessage('bg:setBadge', {
            text:
              (loadingCounts && loadingCounts.toString()) ||
              (successCounts && successCounts.toString()) ||
              (errorCounts && errorCounts.toString()) ||
              null,
            color:
              (loadingCounts && 'yellow') ||
              (successCounts && 'green') ||
              (errorCounts && 'red') ||
              undefined,
          })
        }
      }),

      // メッセージ (現在の再生時間を取得)
      onExtensionMessage('content:getCurrentTime', () => {
        return this.renderer.getCurrentTime()
      }),

      // メッセージ (再描画)
      onExtensionMessage('content:rerender', () => {
        this.renderer.rerender()
      }),

      // メッセージ (再読み込み)
      onExtensionMessage('content:reload', () => {
        this.#trigger('reload')
      }),

      // メッセージ (マーカー)
      onExtensionMessage('content:jumpMarker', ({ data }) => {
        return this.jumpMarker(data)
      }),

      // メッセージ (スクリーンショット)
      onExtensionMessage('content:capture', ({ data }) => {
        return this.renderer.capture(data)
      })
    )
  }

  /**
   * イベント登録解除
   */
  #unregisterEventListener() {
    for (const key in this.#videoEventListeners) {
      const type = key as keyof HTMLVideoElementEventMap
      const listener = this.#videoEventListeners[type]!

      this.video.removeEventListener(type, listener)
    }

    while (this.#removeListenerCallbacks.length) {
      this.#removeListenerCallbacks.pop()?.()
    }
  }

  #listeners: {
    [P in keyof NCOverlayEventMap]?: NCOverlayEventMap[P][]
  } = {}

  #trigger<T extends keyof NCOverlayEventMap>(type: T) {
    if (this.#listeners[type]) {
      for (const listener of this.#listeners[type]) {
        try {
          listener.call(this)
        } catch (err) {
          logger.error(type, err)
        }
      }
    }
  }

  addEventListener<T extends keyof NCOverlayEventMap>(
    type: T,
    callback: NCOverlayEventMap[T]
  ) {
    this.#listeners[type] ??= []
    this.#listeners[type].push(callback)
  }

  removeEventListener<T extends keyof NCOverlayEventMap>(
    type: T,
    callback: NCOverlayEventMap[T]
  ) {
    this.#listeners[type] = this.#listeners[type]?.filter(
      (cb) => cb !== callback
    )
  }

  removeAllEventListeners() {
    for (const key in this.#listeners) {
      delete this.#listeners[key as keyof NCOverlayEventMap]
    }
  }
}
