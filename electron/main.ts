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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#020617',
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
