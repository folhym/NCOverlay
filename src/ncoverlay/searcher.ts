import type { ParsedResult } from '@midra/nco-utils/parse'
import type { SnapshotV2DataWithFields } from '@midra/nco-utils/search/services/niconico'
import type { JikkyoChannelId } from '@midra/nco-utils/types/api/constants'
import type * as ThreadsV1 from '@midra/nco-utils/types/api/niconico/threads/v1'
import type { AutoSearchTarget } from '@/types/storage'
import type { GetNiconicoCommentResult } from '@/utils/api/niconico/getNiconicoComment'
import type {
  NCOState,
  StateSlot,
  StateSlotDetail,
  StateSlotDetailDefault,
  StateSlotDetailUpdate,
} from './state'

import { parse } from '@midra/nco-utils/parse'
import {
  jikkyoSyobocalChIdMap,
  syobocalJikkyoChIdMap,
} from '@midra/nco-utils/api/constants'
import { NICO_LIVE_ANIME_ROOT } from '@midra/nco-utils/api/services/nicolog/list'
import { REGEXP_DANIME_CHAPTER } from '@midra/nco-utils/search/constants'

import { filterAutomaticSearchTargets } from '@/timeline-sync/sourcePolicy'
import { logger } from '@/utils/logger'
import { getJikkyoKakolog } from '@/utils/api/jikkyo/getJikkyoKakolog'
import { getNicologComment } from '@/utils/api/nicolog/getNicologComment'
import { nicologDetailToSlotDetail } from '@/utils/api/nicolog/nicologDetailToSlotDetail'
import { getNiconicoComment } from '@/utils/api/niconico/getNiconicoComment'
import { snapshotV2DataToSlotDetail } from '@/utils/api/niconico/snapshotV2ToSlotDetail'
import {
  convertProgramTime,
  getSlotIdFromProgram,
  programToSlotDetail,
} from '@/utils/api/syobocal/programToSlotDetail'
import { ncoSearchProxy } from '@/proxy/nco-utils/search/extension'

export interface NCOSearcherAutoSearchArgs {
  /** 動画タイトル or 解析結果 */
  input: string | ParsedResult
  /** 動画の長さ */
  duration: number
  /** 検索対象 */
  targets: AutoSearchTarget[]
  /** 実況: チャンネル */
  jikkyoChannelIds?: JikkyoChannelId[]
  /** 実況: 再放送を除外する */
  jikkyoIgnoreRerun?: boolean
}

/**
 * NCOverlayの検索担当
 */
export class NCOSearcher {
  static #nextOwner = 0
  readonly #owner = ++NCOSearcher.#nextOwner
  readonly #state: NCOState
  readonly #diagnostics: boolean
  #generation = 0
  #pendingWrite: Promise<unknown> = Promise.resolve()

  constructor(state: NCOState, diagnostics = false) {
    this.#state = state
    this.#diagnostics = diagnostics
  }

  /** Stop stale search/API results and drain state writes before cleanup. */
  cancel() {
    this.#generation++
    return this.#pendingWrite
  }

  #trace(event: string, generation: number, count = 0) {
    if (this.#diagnostics) {
      logger.log('nco.commentLoad', {
        event,
        owner: this.#owner,
        generation,
        current: generation === this.#generation,
        count,
      })
    }
  }

  async autoSearch(args: NCOSearcherAutoSearchArgs) {
    const generation = ++this.#generation
    const isCurrent = () => generation === this.#generation
    const write = async (task: () => Promise<unknown>) => {
      const result = this.#pendingWrite.then(() =>
        isCurrent() ? task() : undefined
      )
      this.#pendingWrite = result.catch(() => {})
      await result
      return isCurrent()
    }
    const targets: AutoSearchTarget[] = filterAutomaticSearchTargets(
      args.targets
    )

    if (!targets.length) return

    args.input = parse(args.input)

    const isAutoLoaded = true
    const { input, duration, jikkyoChannelIds, jikkyoIgnoreRerun } = args

    const channelIds = jikkyoChannelIds
      ?.map((jkId) => jikkyoSyobocalChIdMap.get(jkId))
      .filter((scId) => scId != null)

    // 読み込み済みのスロットID
    const slotDetails = await this.#state.get('slotDetails')
    if (!isCurrent()) return
    const loadedIds = slotDetails?.map((v) => v.id) ?? []

    this.#trace('candidates.request', generation)
    const [searchNiconicoResults, searchSyobocalResults, searchNicologResult] =
      await Promise.all([
        // ニコニコ動画 検索
        ncoSearchProxy.niconico({
          input,
          duration,
          targets: {
            official: targets.includes('official'),
            danime: targets.includes('danime'),
            chapter: targets.includes('chapter'),
            szbh: targets.includes('szbh'),
          },
          userAgent: EXT_USER_AGENT,
        }),

        // ニコニコ実況 過去ログ 検索
        targets.includes('jikkyo')
          ? ncoSearchProxy.syobocal({
              input,
              channelIds,
              userAgent: EXT_USER_AGENT,
            })
          : null,

        // nicolog 検索
        targets.includes('nicolog') ? ncoSearchProxy.nicolog(input) : null,
      ])
    if (!isCurrent()) {
      this.#trace('candidates.stale', generation)
      return
    }

    logger.log('searchNiconicoResults', searchNiconicoResults)
    logger.log('searchSyobocalResults', searchSyobocalResults)
    logger.log('searchNicologResult', searchNicologResult)

    const currentTime = Date.now()

    const syobocalPrograms =
      searchSyobocalResults?.programs.filter(
        (val) => new Date(val.EdTime).getTime() < currentTime
      ) ?? []

    // ロード中のデータ
    const loadingSlotDetails: Record<
      AutoSearchTarget,
      Map<string, StateSlotDetail>
    > = {
      official: new Map(),
      danime: new Map(),
      chapter: new Map(),
      szbh: new Map(),
      jikkyo: new Map(),
      nicolog: new Map(),
    }

    // ニコニコ動画
    function addLoadingSlotDetails(
      type: Exclude<StateSlotDetailDefault['type'], 'normal'>,
      results: SnapshotV2DataWithFields[]
    ) {
      if (!targets.includes(type)) return

      for (const data of results) {
        if (loadedIds.includes(data.contentId)) continue

        let offsetMs: number | undefined

        // オフセット調節
        if (type === 'szbh') {
          const diff = data.lengthSeconds - duration

          if (50 <= diff) {
            offsetMs = diff * -1000
          }
        }

        const slotDetail = snapshotV2DataToSlotDetail(data, {
          type,
          status: 'loading',
          offsetMs,
          isAutoLoaded,
        })

        loadingSlotDetails[type].set(slotDetail.id, slotDetail)
      }
    }

    addLoadingSlotDetails('official', searchNiconicoResults.official)
    addLoadingSlotDetails('danime', searchNiconicoResults.danime)
    addLoadingSlotDetails('chapter', searchNiconicoResults.chapter.slice(0, 1))
    addLoadingSlotDetails('szbh', searchNiconicoResults.szbh)

    // ニコニコ実況 過去ログ
    if (searchSyobocalResults && syobocalPrograms[0]) {
      const slotTitle = [
        searchSyobocalResults.title.Title,
        `#${syobocalPrograms[0].Count}`,
        searchSyobocalResults.subtitle,
      ]
        .filter(Boolean)
        .join(' ')
        .trim()

      for (const program of syobocalPrograms) {
        const slotDetail = programToSlotDetail(slotTitle, program, {
          status: 'loading',
          isAutoLoaded,
        })

        if (
          loadedIds.includes(slotDetail.id) ||
          // 再放送を除外
          (jikkyoIgnoreRerun && slotDetail.info.title.startsWith('🈞'))
        ) {
          continue
        }

        loadingSlotDetails.jikkyo.set(slotDetail.id, slotDetail)
      }
    }

    // nicolog
    if (searchNicologResult && !loadedIds.includes(searchNicologResult.id)) {
      const slotDetail = nicologDetailToSlotDetail(searchNicologResult, {
        status: 'loading',
        isAutoLoaded,
      })

      loadingSlotDetails.nicolog.set(slotDetail.id, slotDetail)
    }

    const loadingSlotDetailsArray = Object.values(loadingSlotDetails).flatMap(
      (v) => [...v.values()]
    )

    if (
      !(await write(() =>
        this.#state.add('slotDetails', ...loadingSlotDetailsArray)
      ))
    )
      return
    this.#trace(
      'candidates.loading',
      generation,
      loadingSlotDetailsArray.length
    )

    // コメント取得
    if (!(await write(() => this.#state.set('status', 'loading')))) return

    // An individual source failure must reach error, not strand all candidates
    // in loading. Ordinals/stages only; never log IDs, URLs or API payloads here.
    let requestIndex = 0
    const loadComment = async (id: string) => {
      const index = ++requestIndex
      this.#trace('comment.start', generation, index)
      try {
        return await getNiconicoComment(id, undefined, (stage) => {
          this.#trace(`comment.${stage}`, generation, index)
        })
      } catch {
        this.#trace('comment.error', generation, index)
        return null
      }
    }

    const jikkyoIds = [...loadingSlotDetails.jikkyo.values()].map((v) => v.id)

    const scPrograms = syobocalPrograms.filter((prog) => {
      return jikkyoIds.includes(getSlotIdFromProgram(prog))
    })

    const [
      commentsOfficial,
      commentsDAnime,
      commentsChapter,
      commentsSzbh,
      commentsJikkyo,
      commentsNicolog,
    ] = await Promise.all([
      // ニコニコ動画 コメント 取得
      Promise.all(
        [...loadingSlotDetails.official.values()].map((detail) => {
          return loadComment(detail.id)
        })
      ),
      Promise.all(
        [...loadingSlotDetails.danime.values()].map((detail) => {
          return loadComment(detail.id)
        })
      ),
      Promise.all(
        (targets.includes('chapter') ? searchNiconicoResults.chapter : []).map(
          (data) => {
            return loadComment(data.contentId)
          }
        )
      ),
      Promise.all(
        [...loadingSlotDetails.szbh.values()].map((detail) => {
          return loadComment(detail.id)
        })
      ),

      // ニコニコ実況 過去ログ 取得
      Promise.all(
        scPrograms.map((prog) => {
          return getJikkyoKakolog(this.#state, {
            jkChId: syobocalJikkyoChIdMap.get(prog.ChID)!,
            starttime: Math.floor(convertProgramTime(prog.StTime) / 1000),
            endtime: Math.floor(convertProgramTime(prog.EdTime) / 1000),
          })
        })
      ),

      // nicolog 取得
      Promise.all(
        [...loadingSlotDetails.nicolog.values()].map((detail) => {
          return getNicologComment(`${NICO_LIVE_ANIME_ROOT}/${detail.id}`)
        })
      ),
    ])
    if (!isCurrent()) {
      this.#trace('comments.stale', generation)
      return
    }
    this.#trace('comments.received', generation, requestIndex)

    logger.log('commentsOfficial', commentsOfficial)
    logger.log('commentsDAnime', commentsDAnime)
    logger.log('commentsChapter', commentsChapter)
    logger.log('commentsSzbh', commentsSzbh)
    logger.log('commentsJikkyo', commentsJikkyo)
    logger.log('commentsNicolog', commentsNicolog)

    const loadedSlotMap = new Map<string, StateSlot>()
    const updateSlotDetailMap = new Map<string, StateSlotDetailUpdate>()

    // 公式, dアニメ, コメント専用
    function addLoadedSlots(
      results: SnapshotV2DataWithFields[],
      comments: (GetNiconicoCommentResult | null)[]
    ) {
      const len = results.length

      for (let i = 0; i < len; i++) {
        const cmt = comments[i]

        if (!cmt) continue

        const { contentId: id } = results[i]!

        const {
          watchResponse: {
            data: { video },
          },
          threads,
          kawaiiCount,
        } = cmt

        loadedSlotMap.set(id, {
          id,
          threads,
          isAutoLoaded,
        })

        updateSlotDetailMap.set(id, {
          id,
          status: 'ready',
          info: {
            count: {
              view: video.count.view,
              comment: video.count.comment,
              kawaii: kawaiiCount,
            },
            thumbnail:
              video.thumbnail.large ||
              video.thumbnail.middle ||
              video.thumbnail.normal,
          },
        })
      }
    }

    addLoadedSlots(
      searchNiconicoResults.official.filter((data) =>
        loadingSlotDetails.official.has(data.contentId)
      ),
      commentsOfficial
    )
    addLoadedSlots(
      searchNiconicoResults.danime.filter((data) =>
        loadingSlotDetails.danime.has(data.contentId)
      ),
      commentsDAnime
    )
    addLoadedSlots(
      searchNiconicoResults.szbh.filter((data) =>
        loadingSlotDetails.szbh.has(data.contentId)
      ),
      commentsSzbh
    )

    // dアニメ(分割)
    if (commentsChapter[0] && commentsChapter.every((v) => v !== null)) {
      const result = searchNiconicoResults.chapter[0]!
      const id = result.contentId
      const {
        data: {
          video: { thumbnail },
        },
      } = commentsChapter[0].watchResponse

      const { groups } = result.title.match(REGEXP_DANIME_CHAPTER)!
      const title = groups!.title!.trim()
      const chapterTitle = `${title} Chapter.1 〜 ${commentsChapter.length}`

      let tmpOffset = 0
      let totalDuration = 0
      let totalCountView = 0
      let totalCountComment = 0
      let totalCountKawaii = 0
      let mergedThreads: ThreadsV1.Thread[] = []

      for (const comment of commentsChapter) {
        const {
          watchResponse: {
            data: { video },
          },
          threads,
          kawaiiCount,
        } = comment

        if (tmpOffset) {
          for (const thread of threads) {
            for (const comment of thread.comments) {
              comment.vposMs += tmpOffset
            }
          }
        }

        tmpOffset += video.duration * 1000
        totalDuration += video.duration
        totalCountView += video.count.view
        totalCountComment += video.count.comment
        totalCountKawaii += kawaiiCount
        mergedThreads.push(...threads)
      }

      loadedSlotMap.set(id, {
        id,
        threads: mergedThreads,
        isAutoLoaded,
      })

      updateSlotDetailMap.set(id, {
        id,
        status: 'ready',
        info: {
          title: chapterTitle,
          duration: totalDuration,
          count: {
            view: totalCountView,
            comment: totalCountComment,
            kawaii: totalCountKawaii,
          },
          thumbnail: thumbnail.large || thumbnail.middle || thumbnail.normal,
        },
      })
    }

    // ニコニコ実況
    for (const cmt of commentsJikkyo) {
      if (!cmt) continue

      const { thread, markers, chapters, kawaiiCount } = cmt
      const id = thread.id

      loadedSlotMap.set(id, {
        id,
        threads: [thread],
        isAutoLoaded,
      })

      updateSlotDetailMap.set(id, {
        id,
        status: 'ready',
        info: {
          count: {
            comment: thread.commentCount,
            kawaii: kawaiiCount,
          },
        },
        markers,
        chapters,
      })
    }

    // nicolog
    for (const cmt of commentsNicolog) {
      if (!cmt) continue

      const {
        detail: { id },
        threads,
        commentCount,
        kawaiiCount,
      } = cmt

      loadedSlotMap.set(id, {
        id,
        threads,
        isAutoLoaded,
      })

      updateSlotDetailMap.set(id, {
        id,
        status: 'ready',
        info: {
          count: {
            comment: commentCount,
            kawaii: kawaiiCount,
          },
        },
      })
    }

    const slots: StateSlot[] = []

    for (const { id } of loadingSlotDetailsArray) {
      const slot = loadedSlotMap.get(id)
      const detail = updateSlotDetailMap.get(id)

      if (slot && detail) {
        slots.push(slot)

        if (
          !(await write(() =>
            this.#state.update('slotDetails', ['id'], detail)
          ))
        )
          return
        this.#trace('slot.ready', generation)
      } else {
        if (
          !(await write(() =>
            this.#state.update('slotDetails', ['id'], {
              id,
              status: 'error',
            })
          ))
        )
          return
        this.#trace('slot.error', generation)
        // await this.#state.remove('slotDetails', { id })
      }
    }

    if (!(await write(() => this.#state.add('slots', ...slots)))) return
    this.#trace('slots.accepted', generation, slots.length)

    this.#state.get('slots').then((val) => {
      logger.log('slots', val)
    })
    this.#state.get('slotDetails').then((val) => {
      logger.log('slotDetails', val)
    })
  }
}
