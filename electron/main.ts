import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { convert, probe, run } from './ffmpeg'
import type { Binaries, ConvertRequest } from './ffmpeg'

// `electron . --dev` attaches to the Vite server; without it the packaged
// build loads dist/ from disk. WA_DEV_URL overrides the port if it moved.
const DEV_URL = process.argv.includes('--dev')
  ? process.env.WA_DEV_URL || 'http://localhost:5173'
  : process.env.WA_DEV_URL

const binDir = app.isPackaged
  ? join(process.resourcesPath, 'ffmpeg')
  : join(__dirname, '..', 'resources', 'ffmpeg')
const exe = (n: string) => join(binDir, process.platform === 'win32' ? n + '.exe' : n)
const bins: Binaries = { ffmpeg: exe('ffmpeg'), ffprobe: exe('ffprobe') }
const binariesPresent = () => existsSync(bins.ffmpeg) && existsSync(bins.ffprobe)

// electron-builder stamps the packaged exe from build/icon.ico; unpackaged runs
// need the file handed to the window directly.
const windowIcon = join(__dirname, '..', 'build', 'icon.png')

/**
 * Set by the renderer while a video is loaded or a conversion is running.
 * Electron never shows Chromium's own beforeunload dialog - it would silently
 * cancel the close instead - so the desktop build asks here.
 */
let exitGuard = false
let confirmedClose = false

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#070A09',
    ...(app.isPackaged || !existsSync(windowIcon) ? {} : { icon: windowIcon }),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  if (DEV_URL) win.loadURL(DEV_URL)
  else win.loadFile(join(__dirname, '..', 'dist', 'index.html'))
  win.on('close', (e) => {
    if (!exitGuard || confirmedClose) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Batal', 'Tutup'],
      defaultId: 0,
      cancelId: 0,
      title: 'Tutup aplikasi?',
      message: 'Video dan hasil konversi akan hilang',
      detail: 'Proses berjalan di perangkat ini dan tidak tersimpan otomatis. Simpan hasilnya dulu sebelum menutup.',
    })
    if (choice === 1) {
      confirmedClose = true
      win.close()
    }
  })
  win.on('closed', () => {
    exitGuard = false
    confirmedClose = false
  })

  // Keep navigation inside the app; anything external opens in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  return win
}

app.whenReady().then(() => {
  ipcMain.handle('wa:info', async () => {
    const ready = binariesPresent()
    let version = ''
    if (ready) {
      const r = await run(bins.ffmpeg, ['-hide_banner', '-version'])
      // -version prints to stdout; stderr is only a fallback for odd builds.
      version = ((r.stdout || r.stderr || '').split(/\r?\n/)[0] || '').trim()
    }
    return { ready, version, ffmpegPath: bins.ffmpeg }
  })

  ipcMain.handle('wa:probe', (_e, inputPath: string) => probe(bins, inputPath))

  ipcMain.handle('wa:convert', (event, req: ConvertRequest) =>
    convert(bins, req, (fraction, label) => {
      if (!event.sender.isDestroyed()) event.sender.send('wa:progress', { fraction, label })
    }),
  )

  ipcMain.handle('wa:save', async (_e, filename: string, bytes: Uint8Array) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: filename,
      filters: [{ name: 'Video MP4', extensions: ['mp4'] }],
    })
    if (canceled || !filePath) return null
    await writeFile(filePath, Buffer.from(bytes))
    return filePath
  })

  // One folder prompt for the whole split, instead of a dialog per part.
  ipcMain.handle('wa:saveAll', async (_e, files: { filename: string; bytes: Uint8Array }[]) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Pilih folder untuk menyimpan semua bagian',
      properties: ['openDirectory', 'createDirectory'],
    })
    const dir = filePaths?.[0]
    if (canceled || !dir) return null
    for (const f of files) await writeFile(join(dir, f.filename), Buffer.from(f.bytes))
    return dir
  })

  ipcMain.handle('wa:reveal', (_e, filePath: string) => shell.showItemInFolder(filePath))

  ipcMain.on('wa:exit-guard', (_e, on: boolean) => {
    exitGuard = Boolean(on)
  })

  // Printed once so a headless run still shows which engine the app will use.
  console.log(
    '[wa-status] ffmpeg:',
    binariesPresent() ? 'native (' + bins.ffmpeg + ')' : 'MISSING -> wasm fallback',
  )
  console.log('[wa-status] loading:', DEV_URL || 'dist/index.html')

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
