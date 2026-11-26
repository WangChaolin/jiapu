import { app, BrowserWindow, nativeImage } from 'electron'
import type { GenealogyMeta, GraphData, GraphPngOptions } from '../shared/types'
import { buildGraphPngSvg } from '../../src/graph/png.ts'

let rendererWindow: BrowserWindow | null = null
let rendererReady: Promise<BrowserWindow> | null = null
let renderQueue: Promise<void> = Promise.resolve()

app.once('will-quit', () => {
  rendererWindow?.destroy()
  rendererWindow = null
  rendererReady = null
})

async function getRendererWindow(): Promise<BrowserWindow> {
  if (rendererWindow && !rendererWindow.isDestroyed()) return rendererWindow
  if (!rendererReady) {
    rendererReady = (async () => {
      const window = new BrowserWindow({
        show: false,
        width: 320,
        height: 180,
        webPreferences: {
          offscreen: true,
          javascript: true,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      })
      rendererWindow = window
      window.webContents.on('render-process-gone', () => {
        if (rendererWindow === window) rendererWindow = null
        if (!window.isDestroyed()) window.destroy()
      })
      try {
        await window.loadURL('data:text/html;charset=utf-8,<html><body></body></html>')
        return window
      } catch (error) {
        if (rendererWindow === window) rendererWindow = null
        if (!window.isDestroyed()) window.destroy()
        throw error
      }
    })().finally(() => { rendererReady = null })
  }
  return rendererReady
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const result = renderQueue.then(task, task)
  renderQueue = result.then(() => undefined, () => undefined)
  return result
}

export async function renderGraphPng(
  data: GraphData,
  meta: GenealogyMeta,
  opts: GraphPngOptions,
): Promise<Uint8Array> {
  const { svg, width, height } = buildGraphPngSvg(data, meta, opts)
  await app.whenReady()
  return enqueue(async () => {
    try {
      // nativeImage does not decode SVG directly. Render it into an offscreen
      // canvas (which preserves alpha), then let nativeImage validate/encode PNG.
      const window = await getRendererWindow()
      const encoded = Buffer.from(svg, 'utf8').toString('base64')
      const pngBase64 = await window.webContents.executeJavaScript(`(async () => {
        const canvas = document.createElement('canvas')
        canvas.width = ${width}
        canvas.height = ${height}
        const context = canvas.getContext('2d')
        if (!context) throw new Error('无法创建二维画布')
        const image = new Image()
        image.src = 'data:image/svg+xml;base64,${encoded}'
        await image.decode()
        await document.fonts.ready
        context.drawImage(image, 0, 0, ${width}, ${height})
        return canvas.toDataURL('image/png').split(',')[1]
      })()`, true)
      if (typeof pngBase64 !== 'string' || !pngBase64) throw new Error('SVG 画布未返回 PNG 数据')

      const image = nativeImage.createFromBuffer(Buffer.from(pngBase64, 'base64'))
      if (image.isEmpty()) throw new Error('图谱 SVG 栅格化失败，无法生成 PNG')
      const size = image.getSize()
      if (size.width !== width || size.height !== height) {
        throw new Error(`图谱 PNG 尺寸异常：期望 ${width} × ${height}，实际为 ${size.width} × ${size.height}`)
      }
      const png = image.toPNG()
      if (!png.length) throw new Error('图谱 PNG 编码失败')
      return new Uint8Array(png)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`图谱 PNG 生成失败：${detail}`)
    }
  })
}
