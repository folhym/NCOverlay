import type * as ThreadsV1 from '@midra/nco-utils/types/api/niconico/threads/v1'
import type { BaseOptions, IRenderer } from '@xpadev-net/niconicomments'
import type { SettingItems } from '@/types/storage'
import type { NCOPatcherFunctions } from './patcher'

import NiconiComments from '@xpadev-net/niconicomments'

import { logger } from '@/utils/logger'
import { getObjectFitRect } from '@/utils/dom/getObjectFitRect'
import { sendExtensionMessage } from '@/messaging/extension'

import { canvasSnapshot } from './canvasDiagnostics'

interface NiconiCommentsOptions
  extends Partial<Omit<BaseOptions, 'mode' | 'format'>> {}

/**
 * NCOverlayの描画担当
 */
export class NCORenderer {
  static #nextOwner = 0
  readonly #owner = ++NCORenderer.#nextOwner
  #canvasGeneration = 0
  #generation = 0
  #disposed = false
  #running = false
  #diagnostics = false
  #surface: IRenderer | null = null
  #video: HTMLVideoElement
  #canvas: HTMLCanvasElement

  #niconicomments: NiconiComments | null = null
  #threads: ThreadsV1.Thread[] | null = null
  #options: NiconiCommentsOptions | null = null

  #offset: number = 0
  #startTimestamp: number = 0
  #startTime: number = 0
  #startTimeVpos: number = 0
  #playbackRate: number = 1

  #intervalMs: number = 1000 / 60
  #frameId: number = 0
  #lastFrameTime: number = 0

  getCurrentTime: () => number

  get video() {
    return this.#video
  }
  get canvas() {
    return this.#canvas
  }

  constructor(
    video: HTMLVideoElement,
    { getCurrentTime, canvasDiagnostics = false }: NCOPatcherFunctions = {}
  ) {
    this.#video = video
    this.#video.classList.add('NCOverlay-Video')

    this.#canvas = this.#createCanvas()

    this.getCurrentTime = getCurrentTime ?? (() => this.#video.currentTime)
    this.#diagnostics = canvasDiagnostics
    if (this.#diagnostics) {
      document.addEventListener('nco:canvas-diagnostic', this.#manualDiagnostic)
      this.#diagnose('create')
    }
  }

  #createCanvas() {
    this.#canvasGeneration++
    const canvas = document.createElement('canvas')
    canvas.classList.add('NCOverlay-Canvas')
    canvas.width = 1920
    canvas.height = 1080

    return canvas
  }

  #replaceCanvas(canvas: HTMLCanvasElement) {
    if (this.#canvas.parentNode) {
      canvas.className = this.#canvas.className
      canvas.style.cssText = this.#canvas.style.cssText

      this.#canvas.replaceWith(canvas)
    }

    this.#canvas = canvas
  }

  dispose() {
    if (this.#disposed) return
    this.#disposed = true
    // Detach the surface before the library releases its WebGL context.
    this.#canvas.remove()
    this.#clear(false)

    this.#options = null

    this.#video.classList.remove('NCOverlay-Video')
    this.#diagnose('dispose')
    document.removeEventListener(
      'nco:canvas-diagnostic',
      this.#manualDiagnostic
    )
  }

  clear() {
    if (this.#disposed) return
    this.#clear(true)
  }

  #clear(replaceCanvas: boolean) {
    this.stop()
    if (replaceCanvas && this.#niconicomments) {
      this.#replaceCanvas(this.#createCanvas())
    }

    this.#niconicomments?.clear()
    this.#niconicomments?.destroy()
    this.#niconicomments = null
    this.#surface = null
    this.#threads = null

    this.#offset = 0
    this.#startTimestamp = 0
    this.#startTime = 0
    this.#startTimeVpos = 0
    this.#playbackRate = 1

    document.body.classList.remove('NCOverlay-Capture')
    this.#diagnose('clear')
  }

  /**
   * @description `reload()` 必須
   */
  setThreads(threads: ThreadsV1.Thread[] | null) {
    if (this.#disposed) return
    this.#threads = threads
  }

  /**
   * @description `reload()` 必須
   */
  setOptions(options: NiconiCommentsOptions | null) {
    if (this.#disposed) return
    this.#options = options
  }

  setOffset(offset: number) {
    if (this.#disposed) return
    if (this.#offset !== offset) {
      this.#offset = offset
      this.#startTimeVpos = Math.max((this.#startTime - this.#offset) * 100, 0)

      if (!this.#frameId) {
        this.render()
      }
    }
  }

  /**
   * @param fps 1以上 or 0 (無制限)
   */
  setFps(fps: number) {
    if (this.#disposed) return
    this.#intervalMs = 0 < fps ? 1000 / fps : 0
  }

  /**
   * @param opacity 0 ~ 1
   */
  setOpacity(opacity: number) {
    if (this.#disposed) return
    this.#canvas.style.opacity = opacity.toString()
  }

  updateTime() {
    if (this.#disposed) return
    this.#startTimestamp = performance.now()
    this.#startTime = this.getCurrentTime()
    this.#startTimeVpos = Math.max((this.#startTime - this.#offset) * 100, 0)
    this.#playbackRate = this.#video.playbackRate
  }

  reload() {
    if (this.#disposed) return
    this.stop()
    if (this.#niconicomments || this.#threads) {
      // Never lose a context on the still-visible old surface.
      this.#replaceCanvas(this.#createCanvas())
    }
    this.#niconicomments?.clear()
    this.#niconicomments?.destroy()
    this.#niconicomments = null
    this.#surface = null

    if (this.#threads) {
      const options = {
        mode: 'html5' as const,
        format: 'v1' as const,
        ...this.#options,
      }
      // Use the library's unchanged default backend, and adopt its fallback
      // canvas if createRenderer replaced the original DOM node.
      const surface = NiconiComments.internal.renderer.createRenderer(
        this.#canvas,
        options.video
      )
      if (surface.canvas !== this.#canvas) this.#canvasGeneration++
      this.#canvas = surface.canvas
      this.#surface = surface
      try {
        this.#niconicomments = new NiconiComments(surface, this.#threads, {
          ...options,
          video: undefined,
        })
      } catch (error) {
        this.#replaceCanvas(this.#createCanvas())
        surface.destroy()
        this.#surface = null
        throw error
      }

      this.rerender()

      if (!this.#video.paused) {
        this.start()
      }
    }
    this.#diagnose('reload')
  }

  render() {
    if (this.#disposed) return
    const vpos =
      this.#startTimeVpos +
      ((performance.now() - this.#startTimestamp) * this.#playbackRate) / 10

    this.#niconicomments?.drawCanvas(vpos)
  }

  rerender() {
    if (this.#disposed) return
    this.updateTime()
    this.render()
  }

  start() {
    if (this.#disposed) return
    this.#stopRequestAnimationFrame()
    this.#running = true

    this.updateTime()

    this.#startRequestAnimationFrame()
  }

  stop() {
    this.#running = false
    this.#stopRequestAnimationFrame()
  }

  #startRequestAnimationFrame() {
    const generation = this.#generation
    this.#frameId = requestAnimationFrame((time) => {
      if (!this.#running || this.#disposed || generation !== this.#generation)
        return
      this.#animationFrameCallback(time)
    })
  }

  #stopRequestAnimationFrame() {
    this.#generation++
    if (this.#frameId) {
      cancelAnimationFrame(this.#frameId)

      this.#frameId = 0
    }
  }

  #animationFrameCallback = (time: number) => {
    if (this.#intervalMs) {
      const delta = time - this.#lastFrameTime

      if (this.#intervalMs < delta) {
        this.#lastFrameTime = time - (delta % this.#intervalMs)

        this.render()
      }
    } else {
      this.render()
    }

    if (this.#running && !this.#disposed) this.#startRequestAnimationFrame()
  }

  #manualDiagnostic = () => this.#diagnose('manual', true)

  #diagnose(
    event: 'create' | 'clear' | 'reload' | 'dispose' | 'manual',
    inspect = false
  ) {
    if (!this.#diagnostics) return
    logger.log(
      'nco.canvasLifecycle',
      canvasSnapshot(
        {
          event,
          owner: this.#owner,
          generation: this.#generation,
          canvasGeneration: this.#canvasGeneration,
          disposed: this.#disposed,
          running: this.#running,
          video: this.#video,
          canvas: this.#canvas,
          surface: this.#surface,
        },
        inspect
      )
    )
  }

  /**
   * スクリーンショット
   */
  async capture(format: SettingItems['capture:format']) {
    if (this.#disposed) return { format }
    document.body.classList.add('NCOverlay-Capture')

    return new Promise<{
      format: 'jpeg' | 'png'
      data?: number[]
    }>((resolve) => {
      setTimeout(async () => {
        let data: number[] | undefined

        try {
          data = await sendExtensionMessage('bg:captureTab', {
            rect: getObjectFitRect(true, this.#canvas, 1920, 1080),
            scale: window.devicePixelRatio,
            format,
          })
        } catch (err) {
          logger.error('capture', err)
        }

        document.body.classList.remove('NCOverlay-Capture')

        resolve({ format, data })
      }, 100)
    })
  }
}
