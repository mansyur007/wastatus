import { contextBridge, ipcRenderer, webUtils } from 'electron'

/**
 * The renderer never gets a raw ipcRenderer or a shell. It can ask for one of
 * four named operations, and the main process builds every FFmpeg argument
 * itself from the settings object - so nothing here can smuggle in a flag.
 */
contextBridge.exposeInMainWorld('waNative', {
  info: () => ipcRenderer.invoke('wa:info'),

  /** Real on-disk path of a dropped File, so ffmpeg reads it without a copy. */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },

  probe: (inputPath: string) => ipcRenderer.invoke('wa:probe', inputPath),

  convert: (req: unknown) => ipcRenderer.invoke('wa:convert', req),

  save: (filename: string, bytes: Uint8Array) => ipcRenderer.invoke('wa:save', filename, bytes),

  saveAll: (files: { filename: string; bytes: Uint8Array }[]) => ipcRenderer.invoke('wa:saveAll', files),

  reveal: (filePath: string) => ipcRenderer.invoke('wa:reveal', filePath),

  /** Arms the "kerja belum selesai" confirm on window close. */
  setExitGuard: (on: boolean) => ipcRenderer.send('wa:exit-guard', on),

  onProgress: (cb: (p: { fraction: number; label: string }) => void) => {
    const handler = (_e: unknown, payload: { fraction: number; label: string }) => cb(payload)
    ipcRenderer.on('wa:progress', handler)
    return () => ipcRenderer.removeListener('wa:progress', handler)
  },
})
