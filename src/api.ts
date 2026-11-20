import type { JiapuApi } from '../electron/preload/index'

declare global {
  interface Window { jiapu: JiapuApi }
}

export const api: JiapuApi = window.jiapu