// Serialize provider requests for one session without coupling separate sessions.
export function createSessionQueue() {
  const queues = new Map()

  async function waitForNextMacrotask(signal) {
    if (signal?.aborted) throw signal.reason
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, 0)
      function done() {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      function abort() {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        reject(signal.reason)
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }

  async function acquire(sessionId, { signal, auxiliary = false } = {}) {
    if (!sessionId) return () => {}
    if (auxiliary) await waitForNextMacrotask(signal)
    if (signal?.aborted) throw signal.reason

    let queue = queues.get(sessionId)
    if (!queue) {
      queue = { held: false, waiters: [] }
      queues.set(sessionId, queue)
    }
    if (!queue.held) {
      queue.held = true
      return makeRelease(sessionId, queue)
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, abort: undefined }
      waiter.abort = () => {
        const index = queue.waiters.indexOf(waiter)
        if (index !== -1) queue.waiters.splice(index, 1)
        signal?.removeEventListener('abort', waiter.abort)
        reject(signal?.reason)
        discardIfEmpty(sessionId, queue)
      }
      queue.waiters.push(waiter)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      if (signal?.aborted) waiter.abort()
    })
  }

  function discardIfEmpty(sessionId, queue) {
    if (!queue.held && queue.waiters.length === 0 && queues.get(sessionId) === queue) queues.delete(sessionId)
  }

  function makeRelease(sessionId, queue) {
    let released = false
    return () => {
      if (released) return
      released = true
      while (queue.waiters.length > 0) {
        const waiter = queue.waiters.shift()
        waiter.signal?.removeEventListener('abort', waiter.abort)
        if (waiter.signal?.aborted) {
          waiter.reject(waiter.signal.reason)
          continue
        }
        waiter.resolve(makeRelease(sessionId, queue))
        return
      }
      queue.held = false
      discardIfEmpty(sessionId, queue)
    }
  }

  return { acquire }
}
