import type { MarkerKey } from '@/constants/markers'
import type {
  OffsetDiagnosticFields,
  OffsetDiagnostics,
} from '@/utils/offsetDiagnostics'
import type { Browser } from '@/utils/webext'
import type { NCOPatcherFunctions } from './patcher'

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
  readonly diagnostics?: OffsetDiagnostics

  readonly #removeListenerCallbacks: (() => void)[] = []
  readonly #port: Browser.runtime.Port
  readonly #diagnosticVideoObserver?: MutationObserver
  #diagnosticStateOffset: number | null | undefined = undefined

  get video() {
    return this.renderer.video
  }
  get canvas() {
    return this.renderer.canvas
  }

  constructor(
    tabId: number,
    video: HTMLVideoElement,
    functions?: NCOPatcherFunctions,
    diagnostics?: OffsetDiagnostics
  ) {
    logger.log('new NCOverlay()')

    this.id = tabId
    this.diagnostics = diagnostics
    this.state = new NCOState(this.id, this.diagnostics?.log)
    this.searcher = new NCOSearcher(this.state)
    this.renderer = new NCORenderer(video, functions, this.diagnostics?.log)
    this.keyboard = new NCOKeyboard(this.state, {
      jumpMarker: (...args) => this.jumpMarker(...args),
    })
    this.diagnostics?.log('overlay.create', this.#getDiagnosticFields())

    this.#port = webext.runtime.connect({ name: 'instance' })
    this.#port.onMessage.addListener((message) => {
      if (message === 'ping') {
        this.#port.postMessage(`pong:${this.id}`)
      }
    })
    if (this.diagnostics) {
      try {
        this.#port.postMessage({
          type: 'offset-diagnostics',
          provider: this.diagnostics.provider,
          generation: this.diagnostics.generation,
        })
      } catch {
        this.diagnostics.log('overlay.diagnostics-port.failed')
      }

      try {
        this.#diagnosticVideoObserver = new MutationObserver(() => {
          this.diagnostics?.log('video.src.attribute-changed')
        })
        this.#diagnosticVideoObserver.observe(video, {
          attributes: true,
          attributeFilter: ['src'],
        })
      } catch {
        this.diagnostics.log('video.src-observer.failed', { phase: 'observe' })
      }
    }

    this.#registerEventListener()

    sendExtensionMessage('bg:setBadge', { text: null })

    // 既にメタデータ読み込み済みの場合
    if (HTMLMediaElement.HAVE_METADATA <= this.video.readyState) {
      setTimeout(() => {
        if (this.diagnostics) {
          this.diagnostics.metadataSource = 'synthetic'
          this.diagnostics.log('video.loadedmetadata', {
            metadataSource: 'synthetic',
            scheduledDelayMs: 100,
          })
        }
        this.#trigger('loadedmetadata')
      }, 100)
    }
  }

  async dispose() {
    logger.log('NCOverlay.dispose()')
    this.diagnostics?.log('overlay.dispose.begin', this.#getDiagnosticFields())
    try {
      this.#diagnosticVideoObserver?.disconnect()
    } catch {
      this.diagnostics?.log('video.src-observer.failed', {
        phase: 'disconnect',
      })
    }

    await this.state.dispose()
    this.renderer.dispose()
    this.keyboard.dispose()
    this.diagnostics?.log(
      'overlay.dispose.teardown',
      this.#getDiagnosticFields()
    )

    this.diagnostics?.log('overlay.port-disconnect')
    this.#port.disconnect()

    this.#unregisterEventListener()
    this.removeAllEventListeners()

    await sendExtensionMessage('bg:setBadge', { text: null })
    this.diagnostics?.log('overlay.dispose.end', this.#getDiagnosticFields())
  }

  async clear() {
    logger.log('NCOverlay.clear()')
    this.diagnostics?.log('overlay.clear.begin', this.#getDiagnosticFields())

    await this.state.clear()
    this.renderer.clear()
    this.diagnostics?.log('overlay.clear.reset', this.#getDiagnosticFields())

    await sendExtensionMessage('bg:setBadge', { text: null })
    this.diagnostics?.log('overlay.clear.end', this.#getDiagnosticFields())
  }

  #getDiagnosticFields(): OffsetDiagnosticFields {
    return {
      ...this.renderer.getDiagnosticSnapshot(),
      stateOffsetKnown: this.#diagnosticStateOffset !== undefined,
      stateOffsetSeconds: this.#diagnosticStateOffset,
      stateOffsetObservation:
        this.#diagnosticStateOffset === undefined
          ? 'unknown'
          : 'storage-on-change',
    }
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
  #updateRendererThreads = async () => {
    const threads = await this.state.getThreads()

    this.renderer.setThreads(threads)
    this.renderer.reload()
  }

  /**
   * イベントリスナー
   */
  #videoEventListeners: {
    [P in keyof HTMLVideoElementEventMap]?: (evt: Event) => void
  } = {
    loadedmetadata: () => {
      logger.log('event', 'loadedmetadata')
      if (this.diagnostics) {
        this.diagnostics.metadataSource = 'native'
        this.diagnostics.log('video.loadedmetadata', {
          metadataSource: 'native',
        })
      }

      this.#trigger('loadedmetadata')
    },

    playing: () => {
      this.diagnostics?.log('video.playing', this.#getDiagnosticFields())
      this.renderer.start()

      this.#trigger('playing')
    },

    pause: () => {
      this.diagnostics?.log('video.pause', this.#getDiagnosticFields())
      this.renderer.stop()

      this.#trigger('pause')
    },

    seeked: () => {
      this.diagnostics?.log('video.seeked', this.#getDiagnosticFields())
      this.renderer.rerender()

      this.#trigger('seeked')
    },

    timeupdate: () => {
      this.#trigger('timeupdate')
    },

    ratechange: () => {
      this.diagnostics?.log('video.ratechange', this.#getDiagnosticFields())
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
      this.state.onChange('offset', (offset, oldOffset) => {
        if (this.diagnostics) {
          this.#diagnosticStateOffset = offset
          this.diagnostics.log('state.offset.changed', {
            ...this.#getDiagnosticFields(),
            oldOffsetSeconds: oldOffset,
            newOffsetSeconds: offset,
          })
        }
        this.renderer.setOffset(offset ?? 0)
      }),

      // スロット
      this.state.onChange('slots', this.#updateRendererThreads),

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
