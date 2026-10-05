import { describe, expect, test } from 'bun:test'

import {
  classifyCommentSource,
  filterAutomaticSearchTargets,
  isAutomaticSearchTarget,
  isTimelineSyncSource,
} from '../../src/timeline-sync/sourcePolicy'
import { snapshotV2DataToSlotDetail } from '../../src/utils/api/niconico/snapshotV2ToSlotDetail'
import { watchDataToSlotDetail } from '../../src/utils/api/niconico/watchDataToSlotDetail'

function snapshot(overrides = {}) {
  return {
    contentId: 'so1',
    title: 'fixture',
    userId: null,
    channelId: null,
    viewCounter: 0,
    lengthSeconds: 1440,
    thumbnailUrl: '',
    startTime: '2026-01-01T00:00:00Z',
    commentCounter: 0,
    categoryTags: null,
    tags: '',
    ...overrides,
  }
}

function watch(channel, title = 'fixture') {
  return {
    channel,
    tags: [],
    video: {
      id: 'so1',
      title,
      duration: 1440,
      registeredAt: '2026-01-01T00:00:00Z',
      count: { view: 0, comment: 0 },
      thumbnail: { large: '', middle: '', normal: '' },
    },
  }
}

describe('automatic comment source policy', () => {
  test('keeps only official, dAnime and its split chapter representation', () => {
    const targets = Object.freeze([
      'jikkyo',
      'official',
      'nicolog',
      'danime',
      'szbh',
      'chapter',
    ])
    expect(filterAutomaticSearchTargets(targets)).toEqual([
      'official',
      'danime',
      'chapter',
    ])
    expect(targets).toEqual([
      'jikkyo',
      'official',
      'nicolog',
      'danime',
      'szbh',
      'chapter',
    ])
    expect(filterAutomaticSearchTargets(['jikkyo', 'nicolog', 'szbh'])).toEqual(
      []
    )
    expect(filterAutomaticSearchTargets([])).toEqual([])
  })

  test('classifies chapter as dAnime and does not infer source from titles', () => {
    expect(classifyCommentSource({ type: 'official' })).toBe('official')
    expect(classifyCommentSource({ type: 'danime' })).toBe('danime')
    expect(classifyCommentSource({ type: 'chapter' })).toBe('danime')
    for (const type of [
      'normal',
      'szbh',
      'jikkyo',
      'nicolog',
      'file',
      'unknown',
    ]) {
      const detail = { type, info: { title: '公式 dアニメ Chapter.1' } }
      expect(classifyCommentSource(detail)).toBeNull()
      expect(isTimelineSyncSource(detail)).toBe(false)
      expect(isAutomaticSearchTarget(type)).toBe(false)
    }
    for (const type of ['official', 'danime', 'chapter']) {
      expect(isTimelineSyncSource({ type })).toBe(true)
      expect(isAutomaticSearchTarget(type)).toBe(true)
    }
  })

  test('uses exact dAnime metadata from existing snapshot and watch adapters', () => {
    expect(
      classifyCommentSource(
        snapshotV2DataToSlotDetail(snapshot({ channelId: 2632720 }))
      )
    ).toBe('danime')
    expect(
      classifyCommentSource(
        watchDataToSlotDetail(
          watch({ id: 'ch2632720', isOfficialAnime: false })
        )
      )
    ).toBe('danime')
    expect(
      classifyCommentSource(
        snapshotV2DataToSlotDetail(snapshot({ title: 'dアニメ Chapter.1' }))
      )
    ).toBeNull()
    expect(
      classifyCommentSource(watchDataToSlotDetail(watch(null, '公式 dアニメ')))
    ).toBeNull()
  })

  test('retains existing official metadata classification', () => {
    expect(
      classifyCommentSource(
        snapshotV2DataToSlotDetail(
          snapshot({ channelId: 123, categoryTags: 'アニメ' })
        )
      )
    ).toBe('official')
    expect(
      classifyCommentSource(
        watchDataToSlotDetail(watch({ id: 'ch123', isOfficialAnime: true }))
      )
    ).toBe('official')
  })
})

// Run module mocks in a subprocess so other timeline tests keep their real imports.
const searcherProbe = String.raw`
import { mock } from 'bun:test'
import assert from 'node:assert/strict'

const mode = process.argv[1]
const calls = []
const comments = []
const writes = []
const snapshot = (contentId, channelId = null) => ({
  contentId, title: 'fixture', channelId, userId: null,
  categoryTags: channelId ? 'アニメ' : null, tags: '', lengthSeconds: 1440,
  viewCounter: 0, commentCounter: 0, thumbnailUrl: '',
  startTime: '2026-01-01T00:00:00Z',
})
globalThis.EXT_USER_AGENT = 'test'
mock.module('@/utils/logger', () => ({ logger: { log() {}, error() {} } }))
mock.module('@/proxy/nco-utils/search/extension', () => ({ ncoSearchProxy: {
  async niconico(args) {
    calls.push(['niconico', args.targets])
    return {
      official: [snapshot('official', 123)],
      danime: [snapshot('danime', 2632720)],
      chapter: [snapshot('chapter', 2632720)],
      szbh: [snapshot('szbh')],
    }
  },
  async syobocal() { calls.push(['jikkyo']); return null },
  async nicolog() { calls.push(['nicolog']); return null },
} }))
mock.module('@/utils/api/niconico/getNiconicoComment', () => ({
  async getNiconicoComment(id) { comments.push(id); return null },
}))
mock.module('@/utils/api/jikkyo/getJikkyoKakolog', () => ({
  getJikkyoKakolog() { throw new Error('jikkyo must not load automatically') },
}))
mock.module('@/utils/api/nicolog/getNicologComment', () => ({
  getNicologComment() { throw new Error('nicolog must not load automatically') },
}))
mock.module('@/utils/api/nicolog/nicologDetailToSlotDetail', () => ({
  nicologDetailToSlotDetail() { throw new Error('nicolog must not be selected') },
}))
mock.module('@/utils/api/syobocal/programToSlotDetail', () => ({
  convertProgramTime() {}, getSlotIdFromProgram() {}, programToSlotDetail() {},
}))

const { NCOSearcher } = await import('./src/ncoverlay/searcher.ts')
const state = {
  async get(key) { writes.push(['get', key]); return null },
  async add(key, ...items) { writes.push(['add', key, items]) },
  async set(key, value) { writes.push(['set', key, value]) },
  async update(key, fields, value) { writes.push(['update', key, value]) },
}
const targets = mode === 'blocked'
  ? ['jikkyo', 'nicolog', 'szbh']
  : mode === 'chapter' ? ['chapter', 'jikkyo']
  : ['official', 'danime', 'jikkyo', 'nicolog', 'szbh']
const args = { input: 'fixture', duration: 1440, targets: [...targets] }
await new NCOSearcher(state).autoSearch(args)
assert.deepEqual(args.targets, targets)
if (mode === 'blocked') {
  assert.deepEqual(calls, [])
  assert.deepEqual(comments, [])
  assert.deepEqual(writes, [])
  assert.equal(args.input, 'fixture')
} else {
  assert.deepEqual(calls, [['niconico', {
    official: mode !== 'chapter', danime: mode !== 'chapter',
    chapter: mode === 'chapter', szbh: false,
  }]])
  const expected = mode === 'chapter' ? ['chapter'] : ['official', 'danime']
  assert.deepEqual(comments, expected)
  const details = writes.find(([action, key]) => action === 'add' && key === 'slotDetails')[2]
  assert.deepEqual(details.map(detail => detail.type), expected)
  assert.ok(details.every(detail => detail.isAutoLoaded === true))
}
console.log('source-policy-searcher-pass')
`

describe('NCOSearcher automatic boundary', () => {
  for (const mode of ['mixed', 'blocked', 'chapter']) {
    test(`applies policy at the real searcher entry (${mode})`, () => {
      const result = Bun.spawnSync({
        cmd: [process.execPath, '--eval', searcherProbe, mode],
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(new TextDecoder().decode(result.stderr)).toBe('')
      expect(result.exitCode).toBe(0)
      expect(new TextDecoder().decode(result.stdout)).toContain(
        'source-policy-searcher-pass'
      )
    })
  }
})
