// Optional real-build smoke: set NCO_PLAYWRIGHT_PATH and NCO_CHROME_PATH when
// Playwright/system Chrome are outside this project. No dependency installs or
// real account/API calls. NCO_UI_BASELINE_CSS enables a before/after comparison.
const assert = require('node:assert/strict'),
  fs = require('node:fs/promises'),
  path = require('node:path')
const { chromium } = require(process.env.NCO_PLAYWRIGHT_PATH || 'playwright')
const root = path.resolve('dist/chrome-mv3')
;(async () => {
  const output = process.env.NCO_UI_OUTPUT_DIR || require('node:os').tmpdir()
  await fs.mkdir(output, { recursive: true })
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, 'manifest.json'), 'utf8')
  )
  const browser = await chromium.launch({
    executablePath: process.env.NCO_CHROME_PATH,
    headless: true,
  })
  try {
    for (const before of process.env.NCO_UI_BASELINE_CSS
      ? [true, false]
      : [false]) {
      const page = await browser.newPage({
          viewport: { width: 800, height: 600 },
        }),
        errors = [],
        styles = []
      page.on('pageerror', (e) => errors.push(e.message))
      await page.route('http://nco.test/**', async (route) => {
        const url = new URL(route.request().url())
        const file = path.resolve(root, '.' + decodeURIComponent(url.pathname))
        assert.ok(file.startsWith(root + path.sep))
        if (file.endsWith('.css')) styles.push(url.pathname)
        await route.fulfill({
          body: await fs.readFile(
            before && url.pathname.includes('/assets/Layout-')
              ? process.env.NCO_UI_BASELINE_CSS
              : file
          ),
          contentType: file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.js')
              ? 'text/javascript'
              : file.endsWith('.html')
                ? 'text/html'
                : undefined,
        })
      })
      await page.addInitScript((manifest) => {
        const event = {
          addListener() {},
          removeListener() {},
          hasListener() {
            return false
          },
        }
        const values = {
          'state:1:vod': 'primeVideo',
          'settings:theme': 'light',
          'state:1:slotDetails': [],
          'state:1:slots': [],
        }
        const local = {
          async get(keys) {
            if (!keys) return values
            return Object.fromEntries(
              (typeof keys === 'string' ? [keys] : keys)
                .filter((k) => k in values)
                .map((k) => [k, values[k]])
            )
          },
          async set(v) {
            Object.assign(values, v)
          },
          async remove() {},
          async getBytesInUse() {
            return 0
          },
          onChanged: event,
        }
        const api = {
          runtime: {
            id: 'fixture',
            getManifest: () => manifest,
            getURL: (p) => 'http://nco.test/' + p,
            async getPlatformInfo() {
              return { os: 'win', arch: 'x86-64' }
            },
            sendMessage: async () => null,
            onMessage: event,
            connect() {
              return { onMessage: event, disconnect() {} }
            },
          },
          storage: { local, onChanged: event },
          tabs: {
            TAB_ID_NONE: -1,
            async query() {
              return [{ id: 1, url: 'https://www.amazon.co.jp/fixture' }]
            },
            async get() {
              return { id: 1 }
            },
            onActivated: event,
          },
          action: {},
          sidePanel: {
            async open() {},
            async setOptions() {},
            async getOptions() {
              return { enabled: true, path: 'sidepanel.html' }
            },
          },
          windows: {},
        }
        Object.assign(globalThis, { browser: api, chrome: api })
      }, manifest)
      await page.goto('http://nco.test/popup.html')
      await page.locator('[role="switch"]').first().waitFor({ timeout: 10000 })
      await page.waitForTimeout(250)
      const evidence = await page.evaluate(() => {
        const sw = document.querySelector('[role="switch"]'),
          label = sw.closest('label'),
          wrap = label.querySelector('[data-slot="wrapper"]')
        const slider =
          document.querySelector('[data-slot="thumb"] [type="range"]') ||
          document.querySelector('[type="range"]')
        const snapshot = (el) => {
          const c = getComputedStyle(el),
            r = el.getBoundingClientRect()
          return {
            width: r.width,
            height: r.height,
            position: c.position,
            whiteSpace: c.whiteSpace,
            opacity: c.opacity,
            appearance: c.appearance,
          }
        }
        return {
          switchInput: snapshot(sw),
          switchWrapper: wrap && snapshot(wrap),
          sliderInput: slider && snapshot(slider),
          sheetCount: document.styleSheets.length,
          dpr: devicePixelRatio,
          scale: visualViewport.scale,
        }
      })
      await page.screenshot({
        path: path.join(
          output,
          before ? 'pr8-ui-before.png' : 'pr8-ui-after.png'
        ),
        fullPage: true,
      })
      console.log(JSON.stringify({ before, evidence, styles, errors }))
      if (!before) {
        assert.deepEqual(errors, [])
        assert.ok(styles.length > 0)
        assert.ok(Number(evidence.switchInput.opacity) < 0.01)
        assert.equal(evidence.switchInput.position, 'absolute')
      }
      await page.close()
    }
  } finally {
    await browser.close()
  }
})().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
