import type { StateKey } from '@/types/storage'
import type { OffsetDiagnosticFields } from '@/utils/offsetDiagnostics'

import { defineBackground } from '#imports'
import { ncoApi } from '@midra/nco-utils/api'
import { ncoSearch } from '@midra/nco-utils/search'

import { GITHUB_URL } from '@/constants'
import { logger } from '@/utils/logger'
import { emitOffsetDiagnostic } from '@/utils/offsetDiagnostics'
import { webext } from '@/utils/webext'
import { getFormsUrl } from '@/utils/extension/getFormsUrl'
import { setBadge } from '@/utils/extension/setBadge'
import { onProxyMessage } from '@/utils/proxy-service/messaging/extension'
import { registerProxy } from '@/utils/proxy-service/register'
import { settings } from '@/utils/settings/extension'
import { storage } from '@/utils/storage/extension'

import clearTemporaryData from './clearTemporaryData'
import migration from './migration'
import registerMessaging from './registerMessaging'
import requestPermissions from './requestPermissions'

const DIAGNOSTIC_PROVIDER_REGEXP = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/
const DIAGNOSTIC_GENERATION_REGEXP = /^[a-zA-Z0-9:_-]{1,128}$/
const STATE_KEY_SUFFIX_REGEXP = /^[a-zA-Z][a-zA-Z0-9]{0,63}$/

export default defineBackground({
  type: 'module',
  main: () => void main(),
})

async function main() {
  logger.log('background.js')

  registerProxy('ncoApi', ncoApi, onProxyMessage)
  registerProxy('ncoSearch', ncoSearch, onProxyMessage)
  registerMessaging()

  // 権限をリクエスト
  requestPermissions()

  // インストール・アップデート時
  webext.runtime.onInstalled.addListener(async ({ reason }) => {
    switch (reason) {
      case 'install':
        if (import.meta.env.PROD) {
          // README
          webext.tabs.create({
            url: `${GITHUB_URL}/blob/main/README.md`,
          })
        }

        break

      case 'update':
        await clearTemporaryData()
        await migration()

        if (import.meta.env.PROD && (await settings.get('showChangelog'))) {
          const { version } = webext.runtime.getManifest()

          // リリースノート
          webext.tabs.create({
            url: `${GITHUB_URL}/releases/tag/v${version}`,
          })
        }

        break
    }
  })

  webext.runtime.onConnect.addListener((port) => {
    const tabId = port.sender?.tab?.id

    switch (port.name) {
      // NCOverlayインスタンス作成時
      case 'instance':
        let ncoId: number | undefined
        let diagnosticMetadata: {
          provider: string
          generation: string
        } | null = null

        let intervalId: NodeJS.Timeout
        let timeoutId: NodeJS.Timeout

        function logDiagnostic(
          event: string,
          fields: OffsetDiagnosticFields = {}
        ) {
          if (!diagnosticMetadata) return

          emitOffsetDiagnostic(event, {
            provider: diagnosticMetadata.provider,
            generation: diagnosticMetadata.generation,
            tabId: tabId ?? null,
            ncoId: ncoId ?? null,
            ...fields,
          })
        }

        function dispose(reason: 'disconnect' | 'heartbeat-timeout') {
          logger.log('dispose()')
          logDiagnostic('background:cleanup-start', { reason })

          // バッジリセット
          if (tabId) {
            setBadge({ text: null, tabId })
          }

          // state削除
          if (ncoId) {
            storage.get().then((values) => {
              const stateKeys = Object.keys(values).filter((key) =>
                key.startsWith(`state:${ncoId}:`)
              ) as StateKey[]

              if (diagnosticMetadata) {
                const offsetBefore =
                  values[`state:${ncoId}:offset` as `state:${number}:offset`]
                const stateKeySuffixes = stateKeys
                  .map((key) => {
                    const suffix = key.slice(`state:${ncoId}:`.length)
                    return STATE_KEY_SUFFIX_REGEXP.test(suffix)
                      ? suffix
                      : '[other]'
                  })
                  .join(',')

                logDiagnostic('background:cleanup-snapshot', {
                  reason,
                  stateKeyCount: stateKeys.length,
                  stateKeySuffixes,
                  offsetBefore:
                    typeof offsetBefore === 'number' &&
                    Number.isFinite(offsetBefore)
                      ? offsetBefore
                      : null,
                })
              }

              if (stateKeys.length) {
                logDiagnostic('background:cleanup-remove-request', {
                  reason,
                  stateKeyCount: stateKeys.length,
                })

                const removal = storage.remove(...stateKeys)

                if (diagnosticMetadata) {
                  void removal
                    .then(
                      () => {
                        logDiagnostic('background:cleanup-remove-complete', {
                          reason,
                          stateKeyCount: stateKeys.length,
                        })
                      },
                      () => {
                        logDiagnostic('background:cleanup-remove-failed', {
                          reason,
                          stateKeyCount: stateKeys.length,
                        })
                      }
                    )
                    .catch(() => {})
                }
              } else {
                logDiagnostic('background:cleanup-no-state', { reason })
              }
            })
          }

          clearInterval(intervalId)
          clearTimeout(timeoutId)
        }

        port.onDisconnect.addListener(() => dispose('disconnect'))

        port.onMessage.addListener((message) => {
          if (typeof message === 'string') {
            const [type, data] = message.split(':')

            switch (type) {
              case 'pong':
                clearTimeout(timeoutId)

                ncoId = Number(data)
                timeoutId = setTimeout(
                  () => dispose('heartbeat-timeout'),
                  15000
                )

                break
            }
          } else if (
            !diagnosticMetadata &&
            message &&
            typeof message === 'object' &&
            message.type === 'offset-diagnostics' &&
            typeof message.provider === 'string' &&
            DIAGNOSTIC_PROVIDER_REGEXP.test(message.provider) &&
            typeof message.generation === 'string' &&
            DIAGNOSTIC_GENERATION_REGEXP.test(message.generation)
          ) {
            diagnosticMetadata = {
              provider: message.provider,
              generation: message.generation,
            }

            logDiagnostic('background:diagnostic-port')
          }
        })

        port.postMessage('ping')

        intervalId = setInterval(() => {
          port.postMessage('ping')
        }, 10000)

        break

      // サイドパネル
      case 'sidepanel':
        port.onDisconnect.addListener(() => {
          webext.sidePanel.setOptions({
            enabled: false,
            tabId,
          })
        })

        break
    }
  })

  // タブ更新時
  webext.tabs.onUpdated.addListener(async (tabId) => {
    if (tabId === webext.tabs.TAB_ID_NONE) return

    if (!(await storage.get(`state:${tabId}:vod`))) {
      webext.sidePanel.setOptions({
        enabled: false,
        path: webext.sidePanel.path,
        tabId,
      })
    }
  })

  // コンテキストメニュー
  webext.contextMenus.removeAll().then(() => {
    webext.contextMenus.create({
      id: 'open-player',
      title: '動画プレイヤー',
      contexts: ['action'],
    })
    webext.contextMenus.create({
      id: 'report',
      title: '不具合報告・機能提案・その他',
      contexts: ['action'],
    })

    webext.contextMenus.onClicked.addListener(async ({ menuItemId }) => {
      switch (menuItemId) {
        case 'open-player':
          webext.tabs.create({
            url: webext.runtime.getURL('/player.html'),
          })

          break

        case 'report':
          webext.tabs.create({
            url: await getFormsUrl(),
          })

          break
      }
    })
  })

  // サイドパネル
  webext.sidePanel.setOptions({ enabled: false })

  // ポップアップをウィンドウで開く (テスト用)
  // webext.action.setPopup({ popup: '' })
  // webext.action.onClicked.addListener((tab) => {
  //   webext.windows.create({
  //     type: 'popup',
  //     url: webext.action.getPopupPath(tab?.id),
  //   })
  // })

  logger.log('settings', await settings.get())
}
