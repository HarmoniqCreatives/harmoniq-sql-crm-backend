/**
 * IANA timezone helpers (DST-aware via Intl). Shared by lead filters and reports.
 */

/**
 * Formats a Date as YYYY-MM-DD in the given IANA timezone.
 * @param {Date} date
 * @param {string} timeZone
 * @returns {string}
 */
function calendarDate(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
function zonedParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
  const parts = formatter.formatToParts(date)
  const map = {}
  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value
    }
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  }
}

/**
 * Converts a wall-clock time in `timeZone` to a UTC Date.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {string} timeZone
 * @returns {Date}
 */
function zonedWallTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone)
    const asUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    )
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second)
    const delta = wanted - asUtc
    guess += delta
    if (delta === 0) {
      break
    }
  }
  return new Date(guess)
}

/**
 * Inclusive start/end UTC instants for a calendar day YYYY-MM-DD in `timeZone`.
 * @param {string} yyyyMmDd
 * @param {string} timeZone
 * @returns {{ start: Date, end: Date }|null}
 */
function companyDayBounds(yyyyMmDd, timeZone) {
  const match = String(yyyyMmDd || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) {
    return null
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (!timeZone) {
    return {
      start: new Date(`${match[0]}T00:00:00.000Z`),
      end: new Date(`${match[0]}T23:59:59.999Z`),
    }
  }
  const start = zonedWallTimeToUtc(year, month, day, 0, 0, 0, timeZone)
  // End exclusive next local midnight, then subtract 1ms for inclusive between filters.
  const nextLocalMidnight = new Date(Date.UTC(year, month - 1, day + 1))
  const nextY = nextLocalMidnight.getUTCFullYear()
  const nextM = nextLocalMidnight.getUTCMonth() + 1
  const nextD = nextLocalMidnight.getUTCDate()
  const nextStart = zonedWallTimeToUtc(nextY, nextM, nextD, 0, 0, 0, timeZone)
  const end = new Date(nextStart.getTime() - 1)
  return { start, end }
}

module.exports = {
  calendarDate,
  zonedParts,
  zonedWallTimeToUtc,
  companyDayBounds,
}
