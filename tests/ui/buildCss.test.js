import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// Run after both WXT builds. Split tokens so Tailwind's automatic test-file
// scanning cannot itself supply the missing dependency utilities.
const utilities = [
  ['sr', 'only'],
  ['touch', 'none'],
  ['whitespace', 'nowrap'],
  ['min', 'w', 'max'],
].map((parts) => parts.join('-'))

describe('generated extension UI CSS', () => {
  for (const browser of ['chrome', 'firefox']) {
    for (const entry of ['popup', 'sidepanel', 'player']) {
      test(`${browser} ${entry} loads CSS with HeroUI control utilities`, async () => {
        const root = resolve(`dist/${browser}-mv3`)
        const html = await Bun.file(resolve(root, `${entry}.html`)).text()
        const assets = [...html.matchAll(/href="([^"]+\.css)"/g)]
        expect(assets.length).toBeGreaterThan(0)
        const css = (
          await Promise.all(
            assets.map(async ([, asset]) => {
              const file = Bun.file(
                resolve(root, asset.startsWith('/') ? asset.slice(1) : asset)
              )
              expect(await file.exists()).toBe(true)
              return file.text()
            })
          )
        ).join('\n')
        for (const utility of utilities) expect(css).toContain(`.${utility}`)
        expect(css).not.toContain('@source')
      })
    }
  }
})
