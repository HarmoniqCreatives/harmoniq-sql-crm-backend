const { Op } = require('sequelize')
const { v4: uuidv4 } = require('uuid')
const { security } = require('../config/security')
const { getModels } = require('../models')
const {
  emailReportDeliveryStatuses,
  emailReportFrequencies,
  emailReportMonthlySchedules,
  emailReportTypes,
  permissionKeys,
  timezones,
} = require('../utils/enums')
const { AppError, errors } = require('../utils/errors')
const { isEmail, isUuid, normalizeEmail, readText } = require('../utils/helpers')
const { messages } = require('../utils/messages')
const { calendarDate } = require('./leadOverdue')
const { toXlsx } = require('./leadExportService')
const { presentLeads } = require('./leadService')
const mailService = require('./mailService')
const { hasPermission } = require('./accessService')
const { deriveIsDeleted, markRestored, markSoftDeleted } = require('../utils/softDelete')

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

let emailReportTimer = null
let emailReportRunning = false

function emailReportWorkerEnabled() {
  // Tests opt in explicitly; avoid background sends during the suite.
  if (process.env.NODE_ENV === 'test' && process.env.EMAIL_REPORTS_ENABLED !== '1') {
    return false
  }
  const raw = process.env.EMAIL_REPORTS_ENABLED
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return true
  }
  return String(raw).trim() !== '0'
}

function readPollMs() {
  const raw = process.env.EMAIL_REPORTS_POLL_MS
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return security.emailReportsPollMs
  }
  const value = Number(String(raw).trim())
  if (!Number.isFinite(value) || value < 5000) {
    return security.emailReportsPollMs
  }
  return value
}

function readLeaseMs() {
  return security.emailReportsLeaseMs
}

/**
 * Prefer EMAIL_REPORTS_TIMEZONE when set; otherwise company timezone; else default.
 * @param {object} company
 * @param {{ strict?: boolean }} [options]
 */
function resolveReportTimezone(company, { strict = false } = {}) {
  const raw = process.env.EMAIL_REPORTS_TIMEZONE
  if (raw !== undefined && raw !== null && String(raw).trim() !== '') {
    const value = String(raw).trim()
    if (!Object.values(timezones).includes(value)) {
      if (strict) {
        throw new AppError(errors.emailReportsTimezoneInvalid, 503)
      }
      console.warn(JSON.stringify({
        event: 'email_reports_timezone_invalid',
        value,
        fallback: security.emailReportsDefaultTimezone,
      }))
      return security.emailReportsDefaultTimezone
    }
    return value
  }
  if (company && company.timezone && Object.values(timezones).includes(company.timezone)) {
    return company.timezone
  }
  return security.emailReportsDefaultTimezone
}

function reportTypeLabel(reportType) {
  if (reportType === emailReportTypes.leadReport) {
    return messages.emailReportLeadName
  }
  return reportType
}

function periodLabel(report) {
  if (report.frequency === emailReportFrequencies.daily) {
    return messages.emailReportPeriodDaily
  }
  if (report.monthlySchedule === emailReportMonthlySchedules.start) {
    return messages.emailReportPeriodMonthlyStart
  }
  return messages.emailReportPeriodMonthlyEnd
}

function presentEmailReport(report) {
  return {
    id: report.id,
    reportType: report.reportType,
    reportName: reportTypeLabel(report.reportType),
    recipients: Array.isArray(report.recipients) ? report.recipients.map((item) => String(item)) : [],
    sendHour: report.sendHour,
    sendMinute: report.sendMinute,
    sendMeridiem: report.sendMeridiem,
    frequency: report.frequency,
    monthlySchedule: report.monthlySchedule || null,
    periodLabel: periodLabel(report),
    deletedAt: report.deletedAt || null,
    is_deleted: deriveIsDeleted(report),
    isDeleted: deriveIsDeleted(report),
  }
}

async function presentEmailReports(company) {
  const { CompanyEmailReport } = getModels()
  const reports = await CompanyEmailReport.findAll({
    where: { companyId: company.id },
    order: [['createdAt', 'ASC']],
  })
  return {
    enabled: Boolean(company.emailReportsEnabled),
    timezone: resolveReportTimezone(company),
    reports: reports.map(presentEmailReport),
  }
}

function normalizeRecipients(rawRecipients) {
  const list = Array.isArray(rawRecipients) ? rawRecipients : []
  const recipients = []
  const seen = new Set()
  for (const item of list) {
    const email = normalizeEmail(String(item || ''))
    if (!email) {
      continue
    }
    if (!isEmail(email)) {
      throw new AppError(errors.emailReportRecipientsInvalid, 400)
    }
    if (seen.has(email)) {
      throw new AppError(errors.emailReportRecipientDuplicate, 400)
    }
    seen.add(email)
    recipients.push(email)
  }
  if (recipients.length === 0) {
    throw new AppError(errors.emailReportRecipientsInvalid, 400)
  }
  if (recipients.length > security.emailReportsMaxRecipients) {
    throw new AppError(errors.emailReportRecipientLimit, 400)
  }
  return recipients
}

function normalizeReportInput(body) {
  if (!body || typeof body !== 'object') {
    throw new AppError(errors.emailReportConfigInvalid, 400)
  }
  const reportType = readText(body, 'reportType') || emailReportTypes.leadReport
  if (!Object.values(emailReportTypes).includes(reportType)) {
    throw new AppError(errors.emailReportTypeInvalid, 400)
  }
  const recipients = normalizeRecipients(body.recipients)
  const sendHour = Number(body.sendHour)
  if (!Number.isInteger(sendHour) || sendHour < 1 || sendHour > 12) {
    throw new AppError(errors.emailReportSendTimeInvalid, 400)
  }
  const sendMinute = Number(body.sendMinute)
  if (!Number.isInteger(sendMinute) || sendMinute < 0 || sendMinute > 59) {
    throw new AppError(errors.emailReportSendTimeInvalid, 400)
  }
  const meridiemRaw = readText(body, 'sendMeridiem') || readText(body, 'sendPeriod')
  const sendMeridiem = String(meridiemRaw || '').toUpperCase()
  if (sendMeridiem !== 'AM' && sendMeridiem !== 'PM') {
    throw new AppError(errors.emailReportSendTimeInvalid, 400)
  }
  const frequency = readText(body, 'frequency') || emailReportFrequencies.daily
  if (!Object.values(emailReportFrequencies).includes(frequency)) {
    throw new AppError(errors.emailReportFrequencyInvalid, 400)
  }
  let monthlySchedule = null
  if (frequency === emailReportFrequencies.monthly) {
    const schedule = readText(body, 'monthlySchedule')
    if (!Object.values(emailReportMonthlySchedules).includes(schedule)) {
      throw new AppError(errors.emailReportMonthlyScheduleInvalid, 400)
    }
    monthlySchedule = schedule
  }
  return {
    reportType,
    recipients,
    sendHour,
    sendMinute,
    sendMeridiem,
    frequency,
    monthlySchedule,
  }
}

async function setEmailReportsEnabled(auth, enabled) {
  const { Company } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  company.emailReportsEnabled = Boolean(enabled)
  await company.save()
  return presentEmailReports(company)
}

async function createEmailReport(auth, body) {
  const { Company, CompanyEmailReport } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const next = normalizeReportInput(body)
  const created = await CompanyEmailReport.create({
    id: uuidv4(),
    companyId: company.id,
    ...next,
  })
  return {
    emailReports: await presentEmailReports(company),
    report: presentEmailReport(created),
  }
}

async function updateEmailReport(auth, reportId, body) {
  if (!isUuid(reportId)) {
    throw new AppError(errors.emailReportNotFound, 404)
  }
  const { Company, CompanyEmailReport } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const report = await CompanyEmailReport.findOne({
    where: { id: reportId, companyId: auth.companyId },
  })
  if (!report) {
    throw new AppError(errors.emailReportNotFound, 404)
  }
  const next = normalizeReportInput(body)
  Object.assign(report, next)
  await report.save()
  return {
    emailReports: await presentEmailReports(company),
    report: presentEmailReport(report),
  }
}

async function deleteEmailReport(auth, reportId) {
  if (!isUuid(reportId)) {
    throw new AppError(errors.emailReportNotFound, 404)
  }
  const { Company, CompanyEmailReport } = getModels()
  const company = await Company.findByPk(auth.companyId)
  if (!company) {
    throw new AppError(errors.companyMissing, 500)
  }
  const report = await CompanyEmailReport.findOne({
    where: { id: reportId, companyId: auth.companyId },
  })
  if (!report) {
    throw new AppError(errors.emailReportNotFound, 404)
  }
  await markSoftDeleted(report, { userId: auth.userId })
  return presentEmailReports(company)
}

async function listDeletedEmailReports(auth) {
  if (!hasPermission(auth, permissionKeys.recycleBinView)) {
    throw new AppError(errors.forbidden, 403)
  }
  const { CompanyEmailReport } = getModels()
  const rows = await CompanyEmailReport.unscoped().findAll({
    where: { companyId: auth.companyId, isDeleted: true },
    order: [['deletedAt', 'DESC']],
  })
  return rows.map(presentEmailReport)
}

async function restoreEmailReport(auth, reportId) {
  if (!hasPermission(auth, permissionKeys.recycleBinRestore)) {
    throw new AppError(errors.forbidden, 403)
  }
  if (!isUuid(reportId)) {
    throw new AppError(errors.emailReportNotFound, 404)
  }
  const { CompanyEmailReport } = getModels()
  const report = await CompanyEmailReport.unscoped().findOne({
    where: { id: reportId, companyId: auth.companyId, isDeleted: true },
  })
  if (!report) {
    throw new AppError(errors.emailReportNotFound, 404)
  }
  await markRestored(report)
  return { message: messages.emailReportRestored, report: presentEmailReport(report) }
}

function to24Hour(hour12, meridiem) {
  const hour = Number(hour12)
  if (meridiem === 'AM') {
    return hour === 12 ? 0 : hour
  }
  return hour === 12 ? 12 : hour + 12
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

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

function zonedWallTimeToUtc(year, month, day, hour, minute, second, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute, second)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(new Date(guess), timeZone)
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second)
    const delta = wanted - asUtc
    guess += delta
    if (delta === 0) {
      break
    }
  }
  return new Date(guess)
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isAtOrPastSendTime(localParts, report) {
  const configuredHour = to24Hour(report.sendHour, report.sendMeridiem)
  const localMinutes = (localParts.hour * 60) + localParts.minute
  const configuredMinutes = (configuredHour * 60) + report.sendMinute
  return localMinutes >= configuredMinutes
}

function pageTypeKey(lead) {
  const name = lead && lead.facebookPageName ? String(lead.facebookPageName).trim() : ''
  if (!name) {
    return messages.dailyLeadEmailUnknownPageType
  }
  return name
}

function sanitizeFilenamePart(value) {
  const cleaned = String(value || '')
    .replace(/[^\w\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  return cleaned || 'Unknown_Page_Type'
}

function buildXlsxFilename(pageType, year, month, usedNames) {
  const monthLabel = MONTH_NAMES[month - 1] || `Month${month}`
  const base = `${sanitizeFilenamePart(pageType)}_Leads_${monthLabel}_${year}.xlsx`
  if (!usedNames.has(base)) {
    usedNames.add(base)
    return base
  }
  let index = 2
  while (usedNames.has(`${sanitizeFilenamePart(pageType)}_Leads_${monthLabel}_${year}_${index}.xlsx`)) {
    index += 1
  }
  const collision = `${sanitizeFilenamePart(pageType)}_Leads_${monthLabel}_${year}_${index}.xlsx`
  usedNames.add(collision)
  return collision
}

/** @deprecated Prefer buildXlsxFilename — kept for callers still importing the old name. */
function buildCsvFilename(pageType, year, month, usedNames) {
  return buildXlsxFilename(pageType, year, month, usedNames)
}

/**
 * Builds one Excel attachment per Facebook Page Type (plus Unknown).
 * Each workbook includes Lead Created Date from lead.createdAt.
 *
 * @param {string} companyId
 * @param {Date} rangeStart
 * @param {Date} rangeEnd
 * @param {number} year
 * @param {number} month
 */
async function buildPageTypeExcelAttachments(companyId, rangeStart, rangeEnd, year, month) {
  const { Lead, Role, User, Company } = getModels()
  const leads = await Lead.findAll({
    where: {
      companyId,
      createdAt: { [Op.between]: [rangeStart, rangeEnd] },
    },
    include: [
      { association: 'tagRows', required: false },
      { association: 'notes', required: false },
      { association: 'feedbacks', required: false },
      { association: 'transfers', required: false },
      { association: 'activities', required: false },
    ],
    order: [['createdAt', 'ASC']],
  })
  const company = await Company.findByPk(companyId)
  const role = await Role.findOne({ where: { companyId, isProtected: true } })
  const user = await User.findOne({ where: { companyId, isInitialSuperAdmin: true } })
  const auth = {
    userId: user ? user.id : null,
    companyId,
    roleId: role ? role.id : null,
    user,
    role,
    company,
  }
  const presented = await presentLeads(auth, leads)
  const groups = new Map()
  for (let index = 0; index < leads.length; index += 1) {
    // Prefer the DB lead's createdAt when presentLeads somehow omits it.
    const row = presented[index] || {}
    if (!row.createdAt && leads[index] && leads[index].createdAt) {
      row.createdAt = leads[index].createdAt
    }
    const key = pageTypeKey(leads[index])
    if (!groups.has(key)) {
      groups.set(key, [])
    }
    groups.get(key).push(row)
  }
  const usedNames = new Set()
  const attachments = []
  const summaries = []
  const sortedKeys = Array.from(groups.keys()).sort((left, right) => left.localeCompare(right))
  for (const key of sortedKeys) {
    const rows = groups.get(key)
    const filename = buildXlsxFilename(key, year, month, usedNames)
    const workbook = await toXlsx(rows)
    attachments.push({
      filename,
      content: workbook,
      contentType: EXCEL_CONTENT_TYPE,
    })
    summaries.push({ filename, pageType: key, leadCount: rows.length })
  }
  return { attachments, summaries, totalLeads: leads.length }
}

/** @deprecated Prefer buildPageTypeExcelAttachments. */
async function buildPageTypeCsvAttachments(companyId, rangeStart, rangeEnd, year, month) {
  return buildPageTypeExcelAttachments(companyId, rangeStart, rangeEnd, year, month)
}

function resolveReportWindow(report, now, timeZone) {
  const parts = zonedParts(now, timeZone)
  const reportingDate = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`

  if (report.frequency === emailReportFrequencies.daily) {
    return {
      due: true,
      deliveryKey: `daily:${reportingDate}:${report.id || 'report'}`,
      reportingDate,
      rangeStart: zonedWallTimeToUtc(parts.year, parts.month, 1, 0, 0, 0, timeZone),
      rangeEnd: now,
      csvYear: parts.year,
      csvMonth: parts.month,
      rangeDescription: 'month to date',
    }
  }

  if (report.monthlySchedule === emailReportMonthlySchedules.start) {
    if (parts.day !== 1) {
      return { due: false, reportingDate }
    }
    let prevYear = parts.year
    let prevMonth = parts.month - 1
    if (prevMonth < 1) {
      prevMonth = 12
      prevYear -= 1
    }
    const lastDay = daysInMonth(prevYear, prevMonth)
    return {
      due: true,
      deliveryKey: `monthly-start:${prevYear}-${pad2(prevMonth)}:${report.id || 'report'}`,
      reportingDate,
      rangeStart: zonedWallTimeToUtc(prevYear, prevMonth, 1, 0, 0, 0, timeZone),
      rangeEnd: zonedWallTimeToUtc(prevYear, prevMonth, lastDay, 23, 59, 59, timeZone),
      csvYear: prevYear,
      csvMonth: prevMonth,
      rangeDescription: 'previous calendar month',
    }
  }

  const lastDay = daysInMonth(parts.year, parts.month)
  if (parts.day !== lastDay) {
    return { due: false, reportingDate }
  }
  return {
    due: true,
    deliveryKey: `monthly-end:${parts.year}-${pad2(parts.month)}:${report.id || 'report'}`,
    reportingDate,
    rangeStart: zonedWallTimeToUtc(parts.year, parts.month, 1, 0, 0, 0, timeZone),
    rangeEnd: now,
    csvYear: parts.year,
    csvMonth: parts.month,
    rangeDescription: 'current calendar month to date',
  }
}

function resolveForcedWindow(report, now, timeZone) {
  const parts = zonedParts(now, timeZone)
  const reportingDate = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
  if (report.frequency === emailReportFrequencies.daily) {
    return {
      due: true,
      deliveryKey: `daily:${reportingDate}:${report.id || 'report'}`,
      reportingDate,
      rangeStart: zonedWallTimeToUtc(parts.year, parts.month, 1, 0, 0, 0, timeZone),
      rangeEnd: now,
      csvYear: parts.year,
      csvMonth: parts.month,
      rangeDescription: 'month to date',
    }
  }
  if (report.monthlySchedule === emailReportMonthlySchedules.start) {
    let prevYear = parts.year
    let prevMonth = parts.month - 1
    if (prevMonth < 1) {
      prevMonth = 12
      prevYear -= 1
    }
    const lastDay = daysInMonth(prevYear, prevMonth)
    return {
      due: true,
      deliveryKey: `monthly-start:${prevYear}-${pad2(prevMonth)}:${report.id || 'report'}`,
      reportingDate,
      rangeStart: zonedWallTimeToUtc(prevYear, prevMonth, 1, 0, 0, 0, timeZone),
      rangeEnd: zonedWallTimeToUtc(prevYear, prevMonth, lastDay, 23, 59, 59, timeZone),
      csvYear: prevYear,
      csvMonth: prevMonth,
      rangeDescription: 'previous calendar month',
    }
  }
  return {
    due: true,
    deliveryKey: `monthly-end:${parts.year}-${pad2(parts.month)}:${report.id || 'report'}`,
    reportingDate,
    rangeStart: zonedWallTimeToUtc(parts.year, parts.month, 1, 0, 0, 0, timeZone),
    rangeEnd: now,
    csvYear: parts.year,
    csvMonth: parts.month,
    rangeDescription: 'current calendar month to date',
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildReportEmailBody({
  company,
  report,
  reportingDate,
  rangeStart,
  rangeEnd,
  summaries,
  totalLeads,
  timeZone,
  rangeDescription,
}) {
  const startLabel = calendarDate(rangeStart, timeZone)
  const endLabel = calendarDate(rangeEnd, timeZone)
  const title = `${reportTypeLabel(report.reportType)} for ${company.name}`
  const lines = [
    title,
    '',
    `Company: ${company.name}`,
    `Timezone: ${timeZone}`,
    `Period: ${periodLabel(report)}`,
    `Reporting date: ${reportingDate}`,
    `Date range: ${startLabel} through ${endLabel} (${rangeDescription})`,
    `Total leads: ${totalLeads}`,
    '',
  ]
  if (summaries.length === 0) {
    lines.push('No leads were found for this period.')
  } else {
    lines.push('Attachments by Page Type:')
    for (const item of summaries) {
      lines.push(`- ${item.filename} (${item.leadCount} leads, Page Type: ${item.pageType})`)
    }
  }
  lines.push('', 'This is an automated message from Melo.')
  const text = lines.join('\n')
  const html = [
    `<p>${escapeHtml(title)}</p>`,
    '<ul>',
    `<li>Company: ${escapeHtml(company.name)}</li>`,
    `<li>Timezone: ${escapeHtml(timeZone)}</li>`,
    `<li>Period: ${escapeHtml(periodLabel(report))}</li>`,
    `<li>Reporting date: ${escapeHtml(reportingDate)}</li>`,
    `<li>Date range: ${escapeHtml(startLabel)} through ${escapeHtml(endLabel)} (${escapeHtml(rangeDescription)})</li>`,
    `<li>Total leads: ${totalLeads}</li>`,
    '</ul>',
  ]
  if (summaries.length === 0) {
    html.push('<p>No leads were found for this period.</p>')
  } else {
    html.push('<p>Attachments by Page Type:</p><ul>')
    for (const item of summaries) {
      html.push(
        `<li>${escapeHtml(item.filename)} (${item.leadCount} leads, Page Type: ${escapeHtml(item.pageType)})</li>`,
      )
    }
    html.push('</ul>')
  }
  html.push('<p>This is an automated message from Melo.</p>')
  return { text, html: html.join('') }
}

async function claimDeliverySlot({
  companyId,
  reportId,
  reportType,
  frequency,
  monthlySchedule,
  deliveryKey,
  reportingDate,
  rangeStart,
  rangeEnd,
  recipients,
}) {
  const { EmailReportDeliveryLog } = getModels()
  const now = new Date()
  const lockExpiresAt = new Date(now.getTime() + readLeaseMs())
  try {
    const created = await EmailReportDeliveryLog.create({
      id: uuidv4(),
      companyId,
      reportId: reportId || null,
      reportType,
      frequency,
      monthlySchedule,
      deliveryKey,
      reportingDate,
      rangeStart,
      rangeEnd,
      recipients,
      attachments: [],
      status: emailReportDeliveryStatuses.processing,
      lockedAt: now,
      lockExpiresAt,
      errorMessage: '',
    })
    return { claimed: true, log: created }
  } catch (error) {
    if (!(error && error.name === 'SequelizeUniqueConstraintError')) {
      throw error
    }
  }

  const existing = await EmailReportDeliveryLog.findOne({
    where: { companyId, reportType, deliveryKey },
  })
  if (!existing) {
    return { claimed: false, log: null }
  }
  if (
    existing.status === emailReportDeliveryStatuses.sent
    || existing.status === emailReportDeliveryStatuses.skipped
  ) {
    return { claimed: false, log: existing }
  }
  const leaseExpired = !existing.lockExpiresAt || existing.lockExpiresAt.getTime() <= now.getTime()
  const canRetry = existing.status === emailReportDeliveryStatuses.failed
    || (existing.status === emailReportDeliveryStatuses.processing && leaseExpired)
  if (!canRetry) {
    return { claimed: false, log: existing }
  }
  const [updated] = await EmailReportDeliveryLog.update({
    status: emailReportDeliveryStatuses.processing,
    errorMessage: '',
    lockedAt: now,
    lockExpiresAt,
    frequency,
    monthlySchedule,
    reportingDate,
    rangeStart,
    rangeEnd,
    recipients,
    attachments: [],
    sentAt: null,
    reportId: reportId || null,
  }, {
    where: {
      id: existing.id,
      companyId,
      reportType,
      deliveryKey,
      [Op.or]: [
        { status: emailReportDeliveryStatuses.failed },
        {
          status: emailReportDeliveryStatuses.processing,
          lockExpiresAt: { [Op.lte]: now },
        },
        {
          status: emailReportDeliveryStatuses.processing,
          lockExpiresAt: { [Op.is]: null },
        },
      ],
    },
  })
  if (!updated) {
    return { claimed: false, log: existing }
  }
  await existing.reload()
  return { claimed: true, log: existing }
}

async function markDeliverySent(log, summaries) {
  log.status = emailReportDeliveryStatuses.sent
  log.attachments = summaries
  log.errorMessage = ''
  log.sentAt = new Date()
  log.lockExpiresAt = null
  await log.save()
  return log
}

async function markDeliveryFailed(log, error) {
  let message = 'send_failed'
  if (error && error.message) {
    message = String(error.message).slice(0, 500)
  }
  log.status = emailReportDeliveryStatuses.failed
  log.errorMessage = message
  log.lockExpiresAt = null
  await log.save()
  return log
}

async function processReport(company, report, now = new Date(), options = {}) {
  const timeZone = resolveReportTimezone(company)
  const local = zonedParts(now, timeZone)
  const windowInfo = resolveReportWindow(report, now, timeZone)
  if (!windowInfo.due && !options.force) {
    return { status: 'not_due', reportingDate: windowInfo.reportingDate }
  }
  if (!options.force && !isAtOrPastSendTime(local, report)) {
    return { status: 'waiting', reportingDate: windowInfo.reportingDate }
  }
  const forcedWindow = options.force && !windowInfo.due
    ? resolveForcedWindow(report, now, timeZone)
    : windowInfo

  const claim = await claimDeliverySlot({
    companyId: company.id,
    reportId: report.id,
    reportType: report.reportType,
    frequency: report.frequency,
    monthlySchedule: report.monthlySchedule || null,
    deliveryKey: forcedWindow.deliveryKey,
    reportingDate: forcedWindow.reportingDate,
    rangeStart: forcedWindow.rangeStart,
    rangeEnd: forcedWindow.rangeEnd,
    recipients: report.recipients,
  })
  if (!claim.claimed) {
    if (claim.log && claim.log.status === emailReportDeliveryStatuses.sent) {
      return { status: 'already_sent', deliveryKey: forcedWindow.deliveryKey, log: claim.log }
    }
    return { status: 'locked', deliveryKey: forcedWindow.deliveryKey, log: claim.log }
  }

  const log = claim.log
  try {
    const built = await buildPageTypeExcelAttachments(
      company.id,
      forcedWindow.rangeStart,
      forcedWindow.rangeEnd,
      forcedWindow.csvYear,
      forcedWindow.csvMonth,
    )
    const body = buildReportEmailBody({
      company,
      report,
      reportingDate: forcedWindow.reportingDate,
      rangeStart: forcedWindow.rangeStart,
      rangeEnd: forcedWindow.rangeEnd,
      summaries: built.summaries,
      totalLeads: built.totalLeads,
      timeZone,
      rangeDescription: forcedWindow.rangeDescription,
    })
    const subject = `${reportTypeLabel(report.reportType)} — ${company.name} — ${forcedWindow.reportingDate}`
    await mailService.sendDailyLeadReportEmail({
      recipients: report.recipients,
      subject,
      text: body.text,
      html: body.html,
      attachments: built.attachments,
    })
    const sent = await markDeliverySent(log, built.summaries)
    console.log(JSON.stringify({
      event: 'email_report_sent',
      companyId: String(company.id),
      reportType: report.reportType,
      deliveryKey: forcedWindow.deliveryKey,
      recipients: report.recipients.length,
      attachments: built.summaries.length,
      totalLeads: built.totalLeads,
    }))
    return {
      status: 'sent',
      deliveryKey: forcedWindow.deliveryKey,
      log: sent,
      summaries: built.summaries,
      totalLeads: built.totalLeads,
    }
  } catch (error) {
    await markDeliveryFailed(log, error)
    console.error(JSON.stringify({
      event: 'email_report_failed',
      companyId: String(company.id),
      reportType: report.reportType,
      deliveryKey: forcedWindow.deliveryKey,
      message: error && error.message ? String(error.message).slice(0, 180) : 'send_failed',
    }))
    return { status: 'failed', deliveryKey: forcedWindow.deliveryKey, error }
  }
}

async function processCompanyEmailReports(company, now = new Date(), options = {}) {
  if (!company.emailReportsEnabled) {
    return { status: 'disabled', results: [] }
  }
  const { CompanyEmailReport } = getModels()
  const reports = await CompanyEmailReport.findAll({ where: { companyId: company.id } })
  if (reports.length === 0) {
    return { status: 'disabled', results: [] }
  }
  const results = []
  for (const report of reports) {
    if (!Array.isArray(report.recipients) || report.recipients.length === 0) {
      results.push({ reportId: report.id, status: 'skipped_no_recipients' })
      continue
    }
    const result = await processReport(company, report, now, options)
    results.push({ reportId: report.id, reportType: report.reportType, ...result })
  }
  return { status: 'processed', results }
}

async function runEmailReportTick(now = new Date()) {
  if (emailReportRunning) {
    return { skipped: true }
  }
  emailReportRunning = true
  try {
    const { Company } = getModels()
    const companies = await Company.findAll({ where: { emailReportsEnabled: true } })
    const results = []
    for (const company of companies) {
      const result = await processCompanyEmailReports(company, now)
      results.push({ companyId: company.id, ...result })
    }
    return { skipped: false, results }
  } finally {
    emailReportRunning = false
  }
}

function startEmailReportWorker() {
  if (!emailReportWorkerEnabled()) {
    return
  }
  if (emailReportTimer) {
    return
  }
  emailReportTimer = setInterval(() => {
    runEmailReportTick().catch((error) => {
      console.error(JSON.stringify({
        event: 'email_report_worker_error',
        message: error && error.message ? String(error.message).slice(0, 180) : 'worker_error',
      }))
    })
  }, readPollMs())
  emailReportTimer.unref()
  setImmediate(() => {
    runEmailReportTick().catch(() => {})
  })
}

function stopEmailReportWorker() {
  if (emailReportTimer) {
    clearInterval(emailReportTimer)
    emailReportTimer = null
  }
}

module.exports = {
  buildCsvFilename,
  buildXlsxFilename,
  buildPageTypeCsvAttachments,
  buildPageTypeExcelAttachments,
  claimDeliverySlot,
  createEmailReport,
  daysInMonth,
  deleteEmailReport,
  listDeletedEmailReports,
  restoreEmailReport,
  emailReportWorkerEnabled,
  isAtOrPastSendTime,
  normalizeReportInput,
  periodLabel,
  presentEmailReports,
  processCompanyEmailReports,
  processReport,
  resolveForcedWindow,
  resolveReportTimezone,
  resolveReportWindow,
  runEmailReportTick,
  setEmailReportsEnabled,
  startEmailReportWorker,
  stopEmailReportWorker,
  to24Hour,
  updateEmailReport,
  zonedParts,
  zonedWallTimeToUtc,
}
