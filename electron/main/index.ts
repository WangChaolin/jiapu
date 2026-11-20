import { app, BrowserWindow, Menu, protocol, shell } from 'electron'
import path from 'node:path'
import { DataStore } from './store.ts'
import { registerIpc, registerPhotoProtocol } from './ipc.ts'

protocol.registerSchemesAsPrivileged([
  { scheme: 'jpimg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

if (process.env['JIAPU_USER_DATA']) {
  app.setPath('userData', process.env['JIAPU_USER_DATA'])
}

let mainWindow: BrowserWindow | null = null
let store: DataStore | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: '家谱管理软件',
    autoHideMenuBar: true,
    backgroundColor: '#f4f1ea',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  })
  Menu.setApplicationMenu(null)
  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url)
    return { action: 'deny' }
  })
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(() => {
    const configPath = path.join(app.getPath('userData'), 'config.json')
    const defaultDataDir = path.join(app.getPath('userData'), 'genealogies')
    store = new DataStore(configPath, defaultDataDir)
    registerPhotoProtocol(store)
    registerIpc(store, () => mainWindow)
    createWindow()
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  })
  app.on('window-all-closed', () => {
    store?.dispose()
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', () => store?.dispose())
}