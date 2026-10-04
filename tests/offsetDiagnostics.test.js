import { afterEach, expect, spyOn, test } from 'bun:test'

import {
  createOffsetDiagnostics,
  emitOffsetDiagnostic,
  getDiagnosticVideoSnapshot,
} from '../src/utils/offsetDiagnostics'
import { createOffsetUiDiagnostics } from '../src/utils/offsetUiDiagnostics'

const TIMESTAMP_REGEXP = /^\d{4}-\d{2}-\d{2}T/
let output

afterEach(() => output?.mockRestore())

function capture() {
  output = spyOn(console, 'info').mockImplementation(() => {})
  return () =>
    JSON.parse(output.mock.calls.at(-1)[0].slice('[NCO-DIAG] '.length))
}

function video() {
  return {
    src: 'blob:https://www.netflix.com/private-source-token',
    currentSrc: 'https://example.com/video?authorization=secret',
    currentTime: 15,
    duration: NaN,
    paused: true,
    playbackRate: 1,
    readyState: 1,
    isConnected: true,
  }
}

test('records are immutable JSON and omit nonprimitive payloads', () => {
  const latest = capture()
  const fields = {
    offsetSeconds: 30,
    durationSeconds: Infinity,
    missing: undefined,
    metadata: { cookie: 'must-not-be-logged' },
  }
  emitOffsetDiagnostic('offset.change', fields)
  fields.offsetSeconds = 0

  const record = latest()
  expect(record.event).toBe('offset.change')
  expect(record.offsetSeconds).toBe(30)
  expect(record.durationSeconds).toBeNull()
  expect(record).not.toHaveProperty('metadata')
  expect(record).not.toHaveProperty('missing')
  expect(record.timestamp).toMatch(TIMESTAMP_REGEXP)
  expect(Number.isFinite(record.elapsedMs)).toBe(true)
})

test('video replacement and source changes can be compared without disclosing URLs', () => {
  const first = video()
  const before = getDiagnosticVideoSnapshot(first)
  const same = getDiagnosticVideoSnapshot(first)
  expect(same.videoId).toBe(before.videoId)
  expect(same.srcRevision).toBe(0)

  first.src = 'blob:https://www.netflix.com/another-private-token'
  const changed = getDiagnosticVideoSnapshot(first)
  expect(changed.videoId).toBe(before.videoId)
  expect(changed.srcRevision).toBe(1)
  expect(getDiagnosticVideoSnapshot(video()).videoId).not.toBe(before.videoId)
  expect(JSON.stringify(changed)).not.toContain('netflix.com')
  expect(JSON.stringify(changed)).not.toContain('private-token')
  expect(JSON.stringify(changed)).not.toContain('authorization')
  expect(changed.srcKind).toBe('blob')
  expect(first.paused).toBe(true)
  expect(first.currentTime).toBe(15)
})

test('session records correlate generations and capture content ID at event time', () => {
  const latest = capture()
  let contentId = '12345'
  const first = createOffsetDiagnostics('netflix', 42, video(), () => contentId)
  const second = createOffsetDiagnostics(
    'netflix',
    42,
    video(),
    () => contentId
  )
  expect(first.generation).not.toBe(second.generation)

  first.log('loadedmetadata', { source: 'native', offsetSeconds: 30 })
  const record = latest()
  expect(record.generation).toBe(first.generation)
  expect(record.provider).toBe('netflix')
  expect(record.tabId).toBe(42)
  expect(record.contentId).toBe('12345')
  expect(record.durationSeconds).toBeNull()
  expect(JSON.stringify(record)).not.toContain('private-source-token')
  expect(JSON.stringify(record)).not.toContain('authorization')

  contentId = '67890'
  first.log('metadata.response')
  expect(latest().contentId).toBe('67890')
  expect(latest().generation).toBe(first.generation)
})

test('console and diagnostic observation failures do not escape to playback code', () => {
  const latest = capture()
  const session = createOffsetDiagnostics('netflix', 42, video(), () => {
    throw new Error('private-error-detail')
  })
  expect(() => session.log('clear.before')).not.toThrow()
  expect(latest().contentIdUnavailable).toBe(true)
  expect(JSON.stringify(latest())).not.toContain('private-error-detail')

  const broken = {
    get src() {
      throw new Error('private-source')
    },
  }
  expect(getDiagnosticVideoSnapshot(broken)).toEqual({
    videoSnapshotUnavailable: true,
  })
  output.mockImplementation(() => {
    throw new Error('console unavailable')
  })
  expect(() => emitOffsetDiagnostic('dispose')).not.toThrow()
  expect(() => session.log('dispose')).not.toThrow()
})

function withUiDocument(run) {
  const savedLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
  const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const page = {
    protocol: 'chrome-extension:',
    pathname: '/sidepanel.html',
    search: '?authorization=private-query',
  }
  const doc = { visibilityState: 'hidden', hasFocus: () => false }
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: page,
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: doc,
  })
  try {
    run(page, doc)
  } finally {
    if (savedLocation) {
      Object.defineProperty(globalThis, 'location', savedLocation)
    } else {
      Reflect.deleteProperty(globalThis, 'location')
    }
    if (savedDocument) {
      Object.defineProperty(globalThis, 'document', savedDocument)
    } else {
      Reflect.deleteProperty(globalThis, 'document')
    }
  }
}

test('UI IDs distinguish instances and snapshot document focus without exposing paths', () => {
  const latest = capture()
  withUiDocument((page, doc) => {
    const global = createOffsetUiDiagnostics('GlobalOffsetControl')
    const control = createOffsetUiDiagnostics('OffsetControl')
    global.log('ui.mount', { stateOffset: 120, offset: 0, currentOffset: 120 })
    const mounted = latest()
    control.log('ui.offset-control.operation', {
      globalUiInstanceId: global.uiInstanceId,
      operation: 'apply',
      applyOffset: 0,
    })
    const applied = latest()
    expect(applied.uiInstanceId).not.toBe(mounted.uiInstanceId)
    expect(applied.contextId).toBe(mounted.contextId)
    expect(applied.globalUiInstanceId).toBe(mounted.uiInstanceId)
    expect(applied.entrypoint).toBe('sidepanel')
    expect(applied.context).toBe('extension-page')
    expect(applied.visibilityState).toBe('hidden')
    expect(applied.hasFocus).toBe(false)
    expect(applied.applyOffset).toBe(0)
    expect(mounted.stateOffset).toBe(120)
    expect(JSON.stringify(applied)).not.toContain('private-query')

    page.pathname = '/private-email@example.com'
    doc.visibilityState = 'visible'
    doc.hasFocus = () => true
    global.log('ui.unmount')
    expect(latest().entrypoint).toBe('unknown')
    expect(latest().visibilityState).toBe('visible')
    expect(latest().hasFocus).toBe(true)
    expect(JSON.stringify(latest())).not.toContain('example.com')
  })
})

test('UI observation errors do not escape into an offset write', () => {
  const latest = capture()
  withUiDocument((_page, doc) => {
    doc.hasFocus = () => {
      throw new Error('private-focus-detail')
    }
    const ui = createOffsetUiDiagnostics('GlobalOffsetControl')
    expect(() => ui.log('ui.global-offset.write')).not.toThrow()
    expect(latest().documentContextUnavailable).toBe(true)
    expect(JSON.stringify(latest())).not.toContain('private-focus-detail')
    output.mockImplementation(() => {
      throw new Error('console unavailable')
    })
    expect(() => ui.log('ui.global-offset.write')).not.toThrow()
  })
})
