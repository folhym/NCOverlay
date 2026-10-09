import type { IRenderer } from '@xpadev-net/niconicomments'

interface CanvasState {
  event: 'create' | 'clear' | 'reload' | 'dispose' | 'manual'
  owner: number
  generation: number
  canvasGeneration: number
  disposed: boolean
  running: boolean
  video: HTMLVideoElement
  canvas: HTMLCanvasElement
  surface: IRenderer | null
}

const COLOR_COMPONENTS = /[\s,/]+/

function finite(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function backgroundAlpha(color: string) {
  if (color === 'transparent') return 0
  if (!color.startsWith('rgb(') && !color.startsWith('rgba(')) return null
  const parts = color
    .slice(color.indexOf('(') + 1, -1)
    .trim()
    .split(COLOR_COMPONENTS)
    .map(Number)
  return parts.every(Number.isFinite)
    ? parts.length === 3
      ? 1
      : parts.length === 4
        ? finite(parts[3])
        : null
    : null
}

/** Numeric/boolean evidence only. Never create a new graphics context to inspect it. */
export function canvasSnapshot(state: CanvasState, inspect = false) {
  const { canvas, video, surface } = state
  const backend = surface as
    | (IRenderer & {
        context?: CanvasRenderingContext2D
        gl?: WebGL2RenderingContext
      })
    | null
  const evidence = {
    event: state.event,
    owner: state.owner,
    generation: state.generation,
    canvasGeneration: state.canvasGeneration,
    disposed: state.disposed,
    running: state.running,
    canvasConnected: canvas.isConnected,
    videoConnected: video.isConnected,
    surfaceMatchesCanvas: surface ? surface.canvas === canvas : null,
    backendWebGL2: surface?.rendererName === 'WebGL2Renderer',
    backendCanvas2D: surface?.rendererName === 'CanvasRenderer',
    canvasWidth: finite(canvas.width),
    canvasHeight: finite(canvas.height),
    videoReadyState: finite(video.readyState),
    videoWidth: finite(video.videoWidth),
    videoHeight: finite(video.videoHeight),
    mediaCurrentTimeMs: finite(video.currentTime * 1000),
    mediaDurationMs: finite(video.duration * 1000),
    videoPaused: video.paused,
    captureMode: document.body.classList.contains('NCOverlay-Capture'),
    overlayCanvasCount: document.querySelectorAll('canvas.NCOverlay-Canvas')
      .length,
    inspect,
    inspectionFailed: false,
    cssHidden: null as boolean | null,
    cssAbsolute: null as boolean | null,
    cssOpacity: null as number | null,
    cssBackgroundAlpha: null as number | null,
    cssZIndex: null as number | null,
    cssTransformed: null as boolean | null,
    canvasX: null as number | null,
    canvasY: null as number | null,
    cssWidth: null as number | null,
    cssHeight: null as number | null,
    contextLost: null as boolean | null,
    contextAlpha: null as boolean | null,
    preserveDrawingBuffer: null as boolean | null,
    pixelSamples: 0,
    transparentSamples: 0,
    opaqueSamples: 0,
    opaqueWhiteSamples: 0,
    pixelReadFailed: false,
  }
  if (!inspect) return evidence
  try {
    const style = getComputedStyle(canvas)
    const rect = canvas.getBoundingClientRect()
    evidence.cssHidden =
      style.display === 'none' || style.visibility === 'hidden'
    evidence.cssAbsolute = style.position === 'absolute'
    evidence.cssOpacity = finite(Number.parseFloat(style.opacity))
    evidence.cssBackgroundAlpha = backgroundAlpha(style.backgroundColor)
    evidence.cssZIndex = finite(Number.parseFloat(style.zIndex))
    evidence.cssTransformed = style.transform !== 'none'
    evidence.canvasX = finite(rect.x)
    evidence.canvasY = finite(rect.y)
    evidence.cssWidth = finite(rect.width)
    evidence.cssHeight = finite(rect.height)
  } catch {
    evidence.inspectionFailed = true
  }
  // Read only the existing backend. A fresh getContext() could itself change
  // backend selection. Probe 25 points, never log/export image or comment data.
  try {
    const gl = backend?.gl
    const context = backend?.context
    if (gl) {
      evidence.contextLost = gl.isContextLost()
      const attributes = gl.getContextAttributes()
      evidence.contextAlpha = attributes?.alpha ?? null
      evidence.preserveDrawingBuffer = attributes?.preserveDrawingBuffer ?? null
      if (
        evidence.contextLost ||
        gl.getParameter(gl.FRAMEBUFFER_BINDING) !== null
      )
        return evidence
    }
    if ((!gl && !context) || canvas.width <= 0 || canvas.height <= 0)
      return evidence
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const x = Math.floor(((canvas.width - 1) * col) / 4)
        const y = Math.floor(((canvas.height - 1) * row) / 4)
        const pixel = new Uint8Array(4)
        if (gl) gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel)
        else pixel.set(context!.getImageData(x, y, 1, 1).data)
        evidence.pixelSamples++
        if (pixel[3] === 0) evidence.transparentSamples++
        if (pixel[3]! >= 250) {
          evidence.opaqueSamples++
          if (pixel[0]! >= 250 && pixel[1]! >= 250 && pixel[2]! >= 250)
            evidence.opaqueWhiteSamples++
        }
      }
    }
    if (gl && gl.getError() !== gl.NO_ERROR) evidence.pixelReadFailed = true
  } catch {
    evidence.pixelReadFailed = true
  }
  return evidence
}
