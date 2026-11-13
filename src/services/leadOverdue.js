/**
 * Calendar-day helpers for follow-ups and activity overdue checks.
 * Dates are stored UTC; comparisons use the company timezone (DST-aware via Intl).
 */

/**
 * Formats a Date as YYYY-MM-DD in the given IANA timezone.
 *
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
 * An activity is overdue only after its calendar date in the company timezone.
 *
 * @param {Date|string|null|undefined} date
 * @param {string} timeZone
 * @returns {boolean}
 */
function isOverdue(date, timeZone) {
  if (!date || !timeZone) {
    return false
  }
  const value = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(value.getTime())) {
    return false
  }
  return calendarDate(value, timeZone) < calendarDate(new Date(), timeZone)
}

module.exports = {
  calendarDate,
  isOverdue,
}
