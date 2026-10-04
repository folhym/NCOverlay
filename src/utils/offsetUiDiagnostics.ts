import type { OffsetDiagnosticFields } from './offsetDiagnostics'

import { emitOffsetDiagnostic } from './offsetDiagnostics'

export type OffsetUiOperation = 'input' | '±button' | 'reset' | 'apply'

const ENTRYPOINTS: Record<string, string> = {
  '/sidepanel.html': 'sidepanel',
  '/popup.html': 'popup',
  '/popout.html': 'popout',
  '/player.html': 'player',
}

let contextId: string | undefined
let instanceSequence = 0

function documentSnapshot(): OffsetDiagnosticFields {
  try {
    const extensionPage =
      location.protocol === 'chrome-extension:' ||
      location.protocol === 'moz-extension:'

    return {
      context: extensionPage ? 'extension-page' : 'content',
      entrypoint: extensionPage
        ? (ENTRYPOINTS[location.pathname] ?? 'unknown')
        : 'content',
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    }
  } catch {
    return { documentContextUnavailable: true }
  }
}

/** Temporary UI identity; no URL, query string, element or event is recorded. */
export function createOffsetUiDiagnostics(component: string) {
  contextId ??= `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const uiContextId = contextId
  const uiInstanceId = `${uiContextId}-ui-${++instanceSequence}`

  return {
    uiInstanceId,
    log(event: string, fields: OffsetDiagnosticFields = {}) {
      emitOffsetDiagnostic(event, {
        ...fields,
        ...documentSnapshot(),
        contextId: uiContextId,
        uiInstanceId,
        component,
        developmentBuild: import.meta.env?.DEV ?? null,
      })
    },
  }
}
