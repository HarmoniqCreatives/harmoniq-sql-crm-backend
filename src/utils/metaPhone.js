const { currencies, timezones } = require('./enums')
const { isInternationalPhone, normalizePhone } = require('./helpers')

/**
 * Meta Lead Ads phone normalization (import path only).
 *
 * Country context (never invent when ambiguous):
 * 1. Company timezone → dial: Asia/Kolkata=+91, Asia/Dubai=+971, Asia/Karachi=+92
 * 2. Else baseCurrency → dial: INR=+91, AED=+971, PKR=+92 (USD/EUR = none)
 * 3. Numbers that already include a known calling code (+, 00, or bare prefix) are
 *    accepted without applying company dial.
 * 4. Local forms (leading 0 / short national) use company dial only when resolved.
 */

const TIMEZONE_DIAL = {
  [timezones.kolkata]: '+91',
  [timezones.dubai]: '+971',
  [timezones.karachi]: '+92',
}

const CURRENCY_DIAL = {
  [currencies.inr]: '+91',
  [currencies.aed]: '+971',
  [currencies.pkr]: '+92',
}

/** Longest-first calling codes from the dial_countries catalog (no DB hit). */
const KNOWN_DIAL_CODES = [
  '+971',
  '+966',
  '+974',
  '+973',
  '+968',
  '+965',
  '+91',
  '+92',
  '+61',
  '+65',
  '+44',
  '+1',
].sort((left, right) => right.length - left.length)

/**
 * @param {{ timezone?: string, baseCurrency?: string }} [context]
 * @returns {string} E.164 dial prefix including +, or ''
 */
function resolveCompanyDialCode(context = {}) {
  const timezone = String(context.timezone || '').trim()
  if (TIMEZONE_DIAL[timezone]) {
    return TIMEZONE_DIAL[timezone]
  }
  const currency = String(context.baseCurrency || '').trim().toUpperCase()
  if (CURRENCY_DIAL[currency]) {
    return CURRENCY_DIAL[currency]
  }
  return ''
}

/**
 * If digits already start with a known calling code, return +E.164 candidate.
 * @param {string} digits
 * @returns {string}
 */
function matchKnownDialPrefix(digits) {
  const raw = String(digits || '')
  for (const code of KNOWN_DIAL_CODES) {
    const codeDigits = code.slice(1)
    if (!raw.startsWith(codeDigits)) continue
    const national = raw.slice(codeDigits.length)
    if (national.length < 7) continue
    const candidate = normalizePhone(`+${raw}`)
    if (isInternationalPhone(candidate)) {
      return candidate
    }
  }
  return ''
}

/**
 * Normalizes a Meta form phone value for lead import.
 *
 * @param {unknown} rawValue
 * @param {{ timezone?: string, baseCurrency?: string }} [context]
 * @returns {{
 *   ok: boolean,
 *   phone: string,
 *   original: string,
 *   reason: string,
 *   rawLength: number,
 *   rawHasPlus: boolean,
 *   digitCount: number,
 * }}
 */
function normalizeMetaLeadPhone(rawValue, context = {}) {
  const original = String(rawValue === undefined || rawValue === null ? '' : rawValue).trim()
  const base = {
    ok: false,
    phone: '',
    original,
    reason: 'empty',
    rawLength: original.length,
    rawHasPlus: original.includes('+'),
    digitCount: 0,
  }
  if (!original) {
    return base
  }

  let cleaned = original.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('00')) {
    cleaned = `+${cleaned.slice(2)}`
  }

  if (cleaned.startsWith('+')) {
    const phone = normalizePhone(cleaned)
    const digitCount = phone.replace(/\D/g, '').length
    if (!isInternationalPhone(phone)) {
      return { ...base, reason: 'invalid_e164', digitCount }
    }
    return {
      ...base,
      ok: true,
      phone,
      reason: '',
      digitCount,
    }
  }

  let digits = cleaned.replace(/\D/g, '')
  base.digitCount = digits.length
  if (!digits) {
    return { ...base, reason: 'empty' }
  }

  const prefixed = matchKnownDialPrefix(digits)
  if (prefixed) {
    return {
      ...base,
      ok: true,
      phone: prefixed,
      reason: '',
      digitCount: digits.length,
    }
  }

  const dial = resolveCompanyDialCode(context)
  if (!dial) {
    return {
      ...base,
      reason: 'ambiguous_country',
      digitCount: digits.length,
    }
  }

  let national = digits
  if (national.startsWith('0')) {
    national = national.slice(1)
  }
  // Avoid double-prefix if national still starts with the company dial digits.
  const dialDigits = dial.slice(1)
  if (national.startsWith(dialDigits)) {
    const candidate = normalizePhone(`+${national}`)
    if (isInternationalPhone(candidate)) {
      return {
        ...base,
        ok: true,
        phone: candidate,
        reason: '',
        digitCount: digits.length,
      }
    }
  }

  // Local national numbers need a plausible length before we attach company dial.
  // (Prevents "12345" + "+971" from becoming a falsely valid E.164.)
  if (national.length < 8 || national.length > 12) {
    return {
      ...base,
      reason: 'invalid_national',
      digitCount: digits.length,
    }
  }

  const candidate = normalizePhone(`${dial}${national}`)
  if (!isInternationalPhone(candidate)) {
    return {
      ...base,
      reason: 'invalid_national',
      digitCount: digits.length,
    }
  }
  return {
    ...base,
    ok: true,
    phone: candidate,
    reason: '',
    digitCount: digits.length,
  }
}

/**
 * Safe debug payload — never includes raw or normalized phone digits.
 * @param {ReturnType<typeof normalizeMetaLeadPhone>} result
 * @param {{ companyId?: string, leadgenId?: string }} [meta]
 * @returns {object}
 */
function metaPhoneDebugEvent(result, meta = {}) {
  return {
    event: 'meta_phone_normalize',
    companyId: meta.companyId || '',
    leadgenId: meta.leadgenId || '',
    rawLength: result.rawLength,
    rawHasPlus: result.rawHasPlus,
    digitCount: result.digitCount,
    ok: result.ok,
    reason: result.reason || '',
  }
}

module.exports = {
  KNOWN_DIAL_CODES,
  TIMEZONE_DIAL,
  CURRENCY_DIAL,
  resolveCompanyDialCode,
  matchKnownDialPrefix,
  normalizeMetaLeadPhone,
  metaPhoneDebugEvent,
}
