/// <reference lib="webworker" />
import { UnsupportedSourceError, checkSupport, convert, probe } from './pipeline'
import type { WorkerRequest, WorkerResponse } from './protocol'

/**
 * The encode runs here, not on the UI thread.
 *
 * Hardware encoding is fast but the per-frame canvas draw is still real work,
 * and doing it on the main thread would stutter the preview and the progress
 * bar for the whole run - the very thing the speed-up is meant to fix.
 */

const post = (message: WorkerResponse, transfer?: Transferable[]) =>
  transfer ? self.postMessage(message, transfer) : self.postMessage(message)

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data
  try {
    if (req.kind === 'support') {
      const support = await checkSupport()
      post({ id: req.id, kind: 'support', ...support })
      return
    }

    if (req.kind === 'probe') {
      post({ id: req.id, kind: 'probed', meta: await probe(req.file) })
      return
    }

    let last = 0
    const parts = await convert(req.file, req.settings, req.meta, (fraction, label) => {
      // The UI only ever renders whole percent, so anything finer is postMessage
      // traffic that buys nothing.
      const now = Date.now()
      if (fraction < 1 && now - last < 100) return
      last = now
      post({ id: req.id, kind: 'progress', fraction, label })
    })
    // The buffers are handed over rather than copied; the worker is done with
    // them the moment they leave.
    post({ id: req.id, kind: 'done', parts }, parts.map((p) => p.buffer))
  } catch (e) {
    post({
      id: req.id,
      kind: 'error',
      message: e instanceof Error ? e.message : 'Konversi gagal.',
      unsupported: e instanceof UnsupportedSourceError,
    })
  }
}
