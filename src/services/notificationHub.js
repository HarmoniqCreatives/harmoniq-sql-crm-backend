/**
 * In-process SSE hub for authenticated notification events.
 * One record per notification — Web and Mobile share the same DB row;
 * this hub only fans out live events to connected sessions for that user.
 */

/** @type {Map<string, Set<import('express').Response>>} */
const userStreams = new Map()

function userKey(companyId, userId) {
  return `${companyId}:${userId}`
}

/**
 * @param {string} companyId
 * @param {string} userId
 * @param {import('express').Response} res
 */
function subscribe(companyId, userId, res) {
  const key = userKey(companyId, userId)
  let set = userStreams.get(key)
  if (!set) {
    set = new Set()
    userStreams.set(key, set)
  }
  set.add(res)
  return () => {
    set.delete(res)
    if (set.size === 0) {
      userStreams.delete(key)
    }
  }
}

/**
 * @param {string} companyId
 * @param {string} userId
 * @param {object} event
 */
function publishToUser(companyId, userId, event) {
  const set = userStreams.get(userKey(companyId, userId))
  if (!set || set.size === 0) {
    return 0
  }
  const payload = `data: ${JSON.stringify(event)}\n\n`
  let sent = 0
  for (const res of set) {
    try {
      res.write(payload)
      sent += 1
    } catch (_error) {
      set.delete(res)
    }
  }
  return sent
}

module.exports = {
  subscribe,
  publishToUser,
}
