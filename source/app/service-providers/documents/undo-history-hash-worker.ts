/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        Hash worker for the differential undo history (R135)
 * CVM-Role:        Utility
 * Maintainer:      Yuanhe Li
 * License:         GNU GPL v3
 *
 * Description:     Computes the SHA-1 check value of large document texts in a
 *                  worker thread, so that the main thread does not stall when it
 *                  writes a check line for a document of more than 256 KB (see
 *                  specification C20, section 4).
 *
 *                  The main process is bundled from the single entry point
 *                  ./source/main.ts, and the packaged application does not carry
 *                  node_modules. A worker that is started from a file path
 *                  therefore cannot be found at run time, and a worker cannot
 *                  import any package. For this reason the worker is a small
 *                  piece of plain JavaScript that only uses built-in Node
 *                  modules, started from a source string.
 *
 * END HEADER
 */

import { Worker } from 'node:worker_threads'

/**
 * The source code of the worker. It answers every message { id, text } with
 * { id, hash } (hash being "sha1:" followed by the 40 lowercase hexadecimal
 * digits of the SHA-1 of the UTF-8 encoded text), or with { id, error } if the
 * calculation failed.
 */
export const UNDO_HISTORY_HASH_WORKER_SOURCE = [
  'const { parentPort } = require(\'node:worker_threads\')',
  'const { createHash } = require(\'node:crypto\')',
  'parentPort.on(\'message\', function (message) {',
  '  try {',
  '    const digest = createHash(\'sha1\').update(message.text, \'utf8\').digest(\'hex\')',
  '    parentPort.postMessage({ id: message.id, hash: \'sha1:\' + digest })',
  '  } catch (error) {',
  '    const description = error !== null && typeof error === \'object\' && typeof error.message === \'string\' ? error.message : String(error)',
  '    parentPort.postMessage({ id: message.id, error: description })',
  '  }',
  '})',
  ''
].join('\n')

/**
 * A hasher that runs in a worker thread.
 */
export interface WorkerHasher {
  /**
   * Calculates the check value of a text in the worker thread. Rejects if the
   * worker fails or exits while the request is open.
   */
  hash: (text: string) => Promise<string>
  /**
   * Stops the worker thread. Open requests are rejected. The hasher stays
   * usable, the next call to hash starts a new worker thread.
   */
  dispose: () => Promise<void>
}

interface PendingRequest {
  resolve: (hash: string) => void
  reject: (error: Error) => void
}

interface WorkerReply {
  id: number
  hash?: string
  error?: string
}

/**
 * Creates a hasher. The worker thread is started when the first hash is
 * requested. If the worker exits unexpectedly, all open requests fail with an
 * error, and the next request starts a new worker.
 *
 * @return  {WorkerHasher}  The hasher
 */
export function createWorkerHasher (): WorkerHasher {
  let worker: Worker | null = null
  let nextRequestId = 1
  const pendingRequests = new Map<number, PendingRequest>()

  const failAllRequests = (error: Error): void => {
    const requests = [...pendingRequests.values()]
    pendingRequests.clear()
    for (const request of requests) {
      request.reject(error)
    }
  }

  const startWorker = (): Worker => {
    const created = new Worker(UNDO_HISTORY_HASH_WORKER_SOURCE, { eval: true })

    created.on('message', (reply: WorkerReply) => {
      const request = pendingRequests.get(reply.id)
      if (request === undefined) {
        return
      }

      pendingRequests.delete(reply.id)
      if (pendingRequests.size === 0) {
        // Do not keep the process alive for an idle worker
        created.unref()
      }

      if (typeof reply.hash === 'string') {
        request.resolve(reply.hash)
      } else {
        request.reject(new Error(reply.error ?? 'The hash worker did not return a hash'))
      }
    })

    created.on('error', (error: Error) => {
      if (worker === created) {
        worker = null
      }
      failAllRequests(error)
    })

    created.on('exit', (exitCode: number) => {
      if (worker === created) {
        worker = null
        failAllRequests(new Error(`The hash worker exited with code ${exitCode}`))
      }
    })

    return created
  }

  const hash = (text: string): Promise<string> => {
    return new Promise<string>((resolve, reject) => {
      try {
        if (worker === null) {
          worker = startWorker()
        }

        const id = nextRequestId
        nextRequestId++
        pendingRequests.set(id, { resolve, reject })
        // Keep the process alive as long as an answer is outstanding
        worker.ref()
        worker.postMessage({ id, text })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  const dispose = async (): Promise<void> => {
    const current = worker
    worker = null
    failAllRequests(new Error('The hash worker was disposed'))
    if (current !== null) {
      await current.terminate()
    }
  }

  return { hash, dispose }
}
