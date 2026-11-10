/*
 * Verifies setting a project icon by pasting in the webapp, in a real
 * browser, with a 300x200 test image: red 50px bands either side of a blue
 * 200px square.
 *
 *  1. pasting a PNG on the preview chip under Settings → Project Config
 *     opens the crop dialog; saving its starting crop uploads the centered
 *     square at 256px, so the red bands are gone;
 *  2. the rail chip then shows that picture in place of the initial;
 *  3. an SVG of the same image also opens the cropper (Chromium decodes it
 *     through an <img>, since createImageBitmap can't), and dragging it to
 *     its left edge before saving brings the left red band into the crop;
 *  4. Remove returns the rail chip to the initial.
 *
 * It creates a throwaway hosted project and deletes it at the end, so it
 * leaves the server's other projects alone. Screenshots go to SHOTS.
 *
 * Run: node test-playwright-scripts/project-icon-paste.js
 */
import path from 'node:path'
import { SHOTS, api, check, finish, origin, requirePlaywright, until } from './lib.js'

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">'
  + '<rect width="300" height="200" fill="#f00"/><rect x="50" width="200" height="200" fill="#00f"/></svg>'

const project = await api('/project/create', { method: 'POST', body: { name: `icon-test-${Date.now() % 100000}` } })
const { chromium } = requirePlaywright()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  await page.goto(`${origin}/?project=${project.id}`)
  await page.locator('[title="Settings"]').click()
  await page.locator('text=Project Config').click()
  const chip = page.locator('[aria-label="Project icon"]')
  await chip.waitFor()
  check('the chip starts on the initial', (await chip.textContent()) === 'I')

  /** Paste the test image as `type` and wait for the cropper to show it. */
  const paste = async (type) => {
    await chip.click()
    await chip.evaluate(async (el, { type, svg }) => {
      let blob = new Blob([svg], { type })
      if (type === 'image/png') {
        const canvas = new OffscreenCanvas(300, 200)
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = '#f00'
        ctx.fillRect(0, 0, 300, 200)
        ctx.fillStyle = '#00f'
        ctx.fillRect(50, 0, 200, 200)
        blob = await canvas.convertToBlob({ type })
      }
      const data = new DataTransfer()
      data.items.add(new File([blob], 'paste', { type }))
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
    }, { type, svg: SVG })
    await until(page, () => {
      const img = document.querySelector('[aria-label="Crop area"] img')
      return img?.complete === true && img.style.visibility !== 'hidden'
    })
  }
  /** Save the crop and read back the stored icon's size and two corners. */
  const saveAndRead = async () => {
    const before = await chip.locator('img').getAttribute('src').catch(() => null)
    await page.getByRole('button', { name: 'Save' }).click()
    await until(page, (prev) => {
      const img = document.querySelector('[aria-label="Project icon"] img')
      return img?.complete === true && img.getAttribute('src') !== prev
    }, before)
    return chip.locator('img').evaluate(async (img) => {
      const bitmap = await createImageBitmap(await (await fetch(img.src)).blob())
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      const ctx = canvas.getContext('2d')
      ctx.drawImage(bitmap, 0, 0)
      const at = (x, y) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)]
      return { width: bitmap.width, height: bitmap.height, corners: [at(2, 2), at(bitmap.width - 3, bitmap.height - 3)] }
    })
  }
  const red = ([r, g, b]) => r > 245 && g < 10 && b < 10
  const blue = ([r, g, b]) => r < 10 && g < 10 && b > 245

  await paste('image/png')
  await page.screenshot({ path: path.join(SHOTS, 'project-icon-cropper.png') })
  const centered = await saveAndRead()
  check('the upload is a 256px square', centered.width === 256 && centered.height === 256, `${centered.width}x${centered.height}`)
  check('the starting crop is the centered square', centered.corners.every(blue), JSON.stringify(centered.corners))
  const railImg = page.locator(`button[title="${project.name}"] img`)
  check('the rail chip shows the picture', await railImg.count() === 1)

  await paste('image/svg+xml')
  const area = await page.locator('[aria-label="Crop area"]').boundingBox()
  await page.mouse.move(area.x + 100, area.y + 100)
  await page.mouse.down()
  await page.mouse.move(area.x + 250, area.y + 100, { steps: 5 })
  await page.mouse.up()
  const dragged = await saveAndRead()
  check('an SVG crops, dragged to its left edge', red(dragged.corners[0]) && blue(dragged.corners[1]),
    JSON.stringify(dragged.corners))

  await page.getByRole('button', { name: 'Remove', exact: true }).click()
  await until(page, () => document.querySelector('[aria-label="Project icon"] img') === null)
  check('Remove returns the rail chip to the initial',
    await railImg.count() === 0 && (await page.locator(`button[title="${project.name}"]`).textContent()) === 'I')
} finally {
  await browser.close()
  await api(`/project/${project.id}`, { method: 'DELETE' })
}
finish()
