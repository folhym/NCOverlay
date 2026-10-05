import type { StateSlotDetail } from '@/ncoverlay/state'
import type { AutoSearchTarget } from '@/types/storage'

export type TimelineSyncSource = 'official' | 'danime'
export type AutomaticSearchTarget = 'official' | 'danime' | 'chapter'

/** Use the existing source classification, without guessing from titles. */
export function classifyCommentSource(
  detail: Pick<StateSlotDetail, 'type'>
): TimelineSyncSource | null {
  switch (detail.type) {
    case 'official':
      return 'official'
    case 'danime':
    case 'chapter':
      // The existing searcher creates chapter slots from dAnime channel 2632720.
      return 'danime'
    default:
      return null
  }
}

export function isTimelineSyncSource(
  detail: Pick<StateSlotDetail, 'type'>
): boolean {
  return classifyCommentSource(detail) !== null
}

export function isAutomaticSearchTarget(
  target: AutoSearchTarget
): target is AutomaticSearchTarget {
  return isTimelineSyncSource({ type: target })
}

/** Apply only to automatic selection; manual source loading keeps its choices. */
export function filterAutomaticSearchTargets(
  targets: readonly AutoSearchTarget[]
): AutomaticSearchTarget[] {
  return targets.filter(isAutomaticSearchTarget)
}
