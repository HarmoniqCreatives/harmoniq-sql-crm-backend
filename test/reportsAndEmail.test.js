const assert = require('node:assert/strict')
const { before, test } = require('node:test')
const { v4: uuidv4 } = require('uuid')
const ExcelJS = require('exceljs')
const request = require('supertest')

process.env.MAIL_DRIVER = 'memory'
process.env.NODE_ENV = 'test'
process.env.APP_BASE_URL = 'https://crm.example.com'
process.env.FRONTEND_URL = 'https://crm.example.com'
process.env.EMAIL_REPORTS_ENABLED = '0'
process.env.LEAD_ASSIGNMENT_EMAIL_ENABLED = '0'

const { app } = require('../src/server')
const { getModels } = require('../src/models')
const {
  buildPageTypeExcelAttachments,
  processCompanyEmailReports,
  resolveReportWindow,
  zonedParts,
  zonedWallTimeToUtc,
  daysInMonth,
} = require('../src/services/emailReportService')
const { toCsv, toXlsx, csvCell } = require('../src/services/leadExportService')
const { clearMemoryOutbox, getMemoryOutbox } = require('../src/services/mailService')
const {
  catalogKinds,
  emailReportFrequencies,
  emailReportMonthlySchedules,
  emailReportTypes,
  roleKeys,
  userStatuses,
} = require('../src/utils/enums')
const { hashPassword } = require('../src/utils/helpers')
const { messages } = require('../src/utils/messages')

const EXCEL_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

async function readExcelSheet(buffer) {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer)
  const sheet = workbook.getWorksheet('Leads') || workbook.worksheets[0]
  const headers = []
  const headerRow = sheet.getRow(1)
  headerRow.eachCell((cell, col) => {
    headers[col] = String(cell.value || '')
  })
  const rows = []
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return
    const record = {}
    headers.forEach((header, col) => {
      if (!header) return
      record[header] = row.getCell(col).value
    })
    rows.push(record)
  })
  return { headers: headers.filter(Boolean), rows, sheet }
}

function formatExcelDate(value) {
  if (!(value instanceof Date)) return ''
  const y = value.getUTCFullYear()
  const m = String(value.getUTCMonth() + 1).padStart(2, '0')
  const d = String(value.getUTCDate()).padStart(2, '0')
  const hh = String(value.getUTCHours()).padStart(2, '0')
  const mm = String(value.getUTCMinutes()).padStart(2, '0')
  const ss = String(value.getUTCSeconds()).padStart(2, '0')
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`
}

function uniqueName(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function registerVerifiedAdmin(prefix = 'ReportCo') {
  clearMemoryOutbox()
  const companyName = uniqueName(prefix)
  const email = `${prefix.toLowerCase()}.${Date.now()}@example.com`
  const register = await request(app).post('/api/auth/register').send({
    companyName,
    adminName: 'Report Admin',
    email,
    phone: '+919876543210',
    password: 'Password1!',
    confirmPassword: 'Password1!',
  })
  assert.equal(register.status, 201)
  const token = decodeURIComponent(getMemoryOutbox().at(-1).text.match(/token=([^\s]+)/)[1])
  await request(app).post('/api/auth/verify-email').send({ token })
  const login = await request(app).post('/api/auth/login').send({
    email,
    password: 'Password1!',
  })
  assert.equal(login.status, 200)
  return {
    email,
    companyId: login.body.data.user.company.id,
    accessToken: login.body.data.accessToken,
    userId: login.body.data.user.id,
  }
}

async function defaultStatusId(token) {
  const statuses = await request(app)
    .get('/api/catalog?kind=STATUS')
    .set('Authorization', `Bearer ${token}`)
  const neu = statuses.body.data.items.find((row) => row.key === 'new')
  assert.ok(neu)
  return neu.id
}

async function createAgent(companyId, name) {
  const { User, Role } = getModels()
  const role = await Role.findOne({ where: { companyId, key: roleKeys.agent } })
  return User.create({
    id: uuidv4(),
    companyId,
    roleId: role.id,
    name,
    email: `${name.toLowerCase().replace(/\s+/g, '.')}.${Date.now()}@example.com`,
    phone: '+971501234567',
    passwordHash: await hashPassword('Password1!'),
    status: userStatuses.active,
    emailVerified: true,
  })
}

before(async () => {
  const { sequelize } = getModels()
  await sequelize.authenticate()
})

test('csvCell escapes quotes and neutralizes formulas', () => {
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('say "hi"'), '"say ""hi"""')
  assert.equal(csvCell('=1+1'), '"\'=1+1"')
})

test('CSV/XLSX export respects filters, includes Unknown page, no pagination truncate, isolates tenants', async () => {
  const a = await registerVerifiedAdmin('ExportA')
  const b = await registerVerifiedAdmin('ExportB')
  const statusId = await defaultStatusId(a.accessToken)
  const agent = await createAgent(a.companyId, 'Export Agent')

  const createMany = []
  for (let index = 0; index < 3; index += 1) {
    createMany.push(request(app)
      .post('/api/leads')
      .set('Authorization', `Bearer ${a.accessToken}`)
      .send({
        name: `Export Lead ${index}`,
        phone: `+97150555${1000 + index}`,
        source: 'facebook',
        statusId,
        primaryAgentId: agent.id,
        facebookPageName: index === 0 ? '' : 'Page Alpha',
        facebookPageId: index === 0 ? '' : 'page-alpha',
      }))
  }
  const created = await Promise.all(createMany)
  assert.ok(created.every((row) => row.status === 201))

  await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${b.accessToken}`)
    .send({
      name: 'Other Co Lead',
      phone: '+971505559999',
      source: 'manual',
      statusId: await defaultStatusId(b.accessToken),
      facebookPageName: 'Other Page',
    })

  const unauth = await request(app).get('/api/leads/export?format=csv')
  assert.equal(unauth.status, 401)

  const csv = await request(app)
    .get('/api/leads/export')
    .query({
      format: 'csv',
      startDate: '2000-01-01',
      endDate: '2099-12-31',
      agentId: agent.id,
      statusId,
    })
    .set('Authorization', `Bearer ${a.accessToken}`)
  assert.equal(csv.status, 200)
  assert.match(csv.headers['content-type'], /text\/csv/)
  assert.match(csv.headers['content-disposition'], /Lead_Report_/)
  const body = String(csv.text || csv.body)
  assert.match(body, /Export Lead 0/)
  assert.match(body, /Export Lead 1/)
  assert.match(body, /Export Lead 2/)
  assert.equal(body.includes('Other Co Lead'), false)
  assert.match(body, /Page Alpha/)

  const unknownOnly = await request(app)
    .get('/api/leads/export')
    .query({
      format: 'csv',
      startDate: '2000-01-01',
      endDate: '2099-12-31',
      pageType: messages.dailyLeadEmailUnknownPageType,
    })
    .set('Authorization', `Bearer ${a.accessToken}`)
  assert.equal(unknownOnly.status, 200)
  assert.match(String(unknownOnly.text || unknownOnly.body), /Export Lead 0/)
  assert.equal(String(unknownOnly.text || unknownOnly.body).includes('Export Lead 1'), false)

  const xlsx = await request(app)
    .get('/api/leads/export')
    .query({ format: 'xlsx', startDate: '2000-01-01', endDate: '2099-12-31' })
    .set('Authorization', `Bearer ${a.accessToken}`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })
  assert.equal(xlsx.status, 200)
  assert.match(xlsx.headers['content-type'], /spreadsheetml/)
  assert.ok(Buffer.isBuffer(xlsx.body))
  assert.ok(xlsx.body.length > 100)

  const cross = await request(app)
    .get('/api/leads/export')
    .query({ format: 'csv', startDate: '2000-01-01', endDate: '2099-12-31' })
    .set('Authorization', `Bearer ${b.accessToken}`)
  assert.equal(String(cross.text || cross.body).includes('Export Lead 0'), false)
})

test('daily and monthly report window + timezone boundaries', () => {
  const timeZone = 'Asia/Kolkata'
  // 2024-03-15 10:30 IST
  const midMonth = zonedWallTimeToUtc(2024, 3, 15, 10, 30, 0, timeZone)
  const daily = resolveReportWindow({
    id: 'r1',
    frequency: emailReportFrequencies.daily,
  }, midMonth, timeZone)
  assert.equal(daily.due, true)
  assert.equal(daily.deliveryKey.startsWith('daily:2024-03-15'), true)
  assert.equal(calendarish(daily.rangeStart, timeZone), '2024-03-01')

  const notFirst = resolveReportWindow({
    id: 'r2',
    frequency: emailReportFrequencies.monthly,
    monthlySchedule: emailReportMonthlySchedules.start,
  }, midMonth, timeZone)
  assert.equal(notFirst.due, false)

  const first = zonedWallTimeToUtc(2024, 4, 1, 9, 0, 0, timeZone)
  const monthlyStart = resolveReportWindow({
    id: 'r2',
    frequency: emailReportFrequencies.monthly,
    monthlySchedule: emailReportMonthlySchedules.start,
  }, first, timeZone)
  assert.equal(monthlyStart.due, true)
  assert.equal(monthlyStart.csvYear, 2024)
  assert.equal(monthlyStart.csvMonth, 3)
  assert.equal(calendarish(monthlyStart.rangeStart, timeZone), '2024-03-01')
  assert.equal(calendarish(monthlyStart.rangeEnd, timeZone), '2024-03-31')

  const lastDay = daysInMonth(2024, 3)
  const endDay = zonedWallTimeToUtc(2024, 3, lastDay, 18, 0, 0, timeZone)
  const monthlyEnd = resolveReportWindow({
    id: 'r3',
    frequency: emailReportFrequencies.monthly,
    monthlySchedule: emailReportMonthlySchedules.end,
  }, endDay, timeZone)
  assert.equal(monthlyEnd.due, true)
  assert.equal(monthlyEnd.csvMonth, 3)

  const parts = zonedParts(midMonth, timeZone)
  assert.equal(parts.hour, 10)
  assert.equal(parts.minute, 30)
})

function calendarish(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

test('email report schedules: CRUD, disabled skip, multi recipients, duplicate prevention, failure log', async () => {
  const admin = await registerVerifiedAdmin('EmailRep')
  const statusId = await defaultStatusId(admin.accessToken)
  await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      name: 'Report Lead',
      phone: '+971505551111',
      source: 'facebook',
      statusId,
      facebookPageName: 'Camp Page',
      facebookPageId: 'camp-page',
    })

  const enable = await request(app)
    .patch('/api/company/email-reports/enabled')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({ enabled: true })
  assert.equal(enable.status, 200)
  assert.equal(enable.body.data.emailReports.enabled, true)

  const created = await request(app)
    .post('/api/company/email-reports')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      reportType: emailReportTypes.leadReport,
      recipients: ['ops@example.com', 'mgr@example.com'],
      sendHour: 9,
      sendMinute: 0,
      sendMeridiem: 'AM',
      frequency: emailReportFrequencies.daily,
    })
  assert.equal(created.status, 201)
  const reportId = created.body.data.report.id
  assert.equal(created.body.data.report.recipients.length, 2)

  const invalid = await request(app)
    .post('/api/company/email-reports')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      reportType: emailReportTypes.leadReport,
      recipients: ['not-an-email'],
      sendHour: 9,
      sendMinute: 0,
      sendMeridiem: 'AM',
      frequency: emailReportFrequencies.daily,
    })
  assert.equal(invalid.status, 400)

  const { Company } = getModels()
  const company = await Company.findByPk(admin.companyId)
  const { CompanyEmailReport } = getModels()
  const report = await CompanyEmailReport.findByPk(reportId)

  clearMemoryOutbox()
  const first = await processCompanyEmailReports(company, new Date(), { force: true })
  assert.equal(first.status, 'processed')
  assert.equal(first.results[0].status, 'sent')
  const outbox = getMemoryOutbox().filter((row) => Array.isArray(row.to) || String(row.to).includes('@'))
  const reportMail = outbox.find((row) => String(row.subject || '').includes('Lead Report'))
  assert.ok(reportMail)
  assert.ok(Array.isArray(reportMail.attachments))
  assert.ok(reportMail.attachments.every((file) => String(file.filename).endsWith('.xlsx')))
  assert.ok(reportMail.attachments.every((file) => file.contentType === EXCEL_CONTENT_TYPE))
  const campAttachment = reportMail.attachments.find((file) => String(file.filename).includes('Camp_Page'))
  assert.ok(campAttachment)
  const campSheet = await readExcelSheet(campAttachment.content)
  assert.ok(campSheet.headers.includes(messages.csvCreatedAt))
  assert.equal(messages.csvCreatedAt, 'Lead Created Date')
  const reportLead = campSheet.rows.find((row) => row[messages.csvName] === 'Report Lead')
  assert.ok(reportLead)
  assert.ok(reportLead[messages.csvCreatedAt] instanceof Date)
  assert.ok(
    Array.isArray(reportMail.to)
      ? reportMail.to.includes('ops@example.com')
      : String(reportMail.to).includes('ops@example.com'),
  )

  const second = await processCompanyEmailReports(company, new Date(), { force: true })
  assert.equal(second.results[0].status, 'already_sent')

  company.emailReportsEnabled = false
  await company.save()
  const disabled = await processCompanyEmailReports(company, new Date(), { force: true })
  assert.equal(disabled.status, 'disabled')

  company.emailReportsEnabled = true
  await company.save()
  report.recipients = ['fail@example.com']
  await report.save()
  const originalSend = require('../src/services/mailService').sendDailyLeadReportEmail
  const mailService = require('../src/services/mailService')
  mailService.sendDailyLeadReportEmail = async () => {
    throw new Error('provider down')
  }
  try {
    // New delivery key via different reporting date force path still same day key — mutate delivery by changing report id key through reload
    const { EmailReportDeliveryLog } = getModels()
    await EmailReportDeliveryLog.destroy({ where: { companyId: admin.companyId } })
    const failed = await processCompanyEmailReports(company, new Date(), { force: true })
    assert.equal(failed.results[0].status, 'failed')
    const log = await EmailReportDeliveryLog.findOne({ where: { companyId: admin.companyId } })
    assert.equal(log.status, 'failed')
    assert.match(log.errorMessage, /provider down/)
  } finally {
    mailService.sendDailyLeadReportEmail = originalSend
  }

  const removed = await request(app)
    .delete(`/api/company/email-reports/${reportId}`)
    .set('Authorization', `Bearer ${admin.accessToken}`)
  assert.equal(removed.status, 200)
  assert.equal(removed.body.data.emailReports.reports.length, 0)
})

test('toCsv includes presented rows and Lead Created Date', () => {
  const createdAt = new Date('2024-01-01T00:00:00Z')
  const csv = toCsv([{
    label: '#1',
    name: 'A',
    phone: '+1',
    email: '',
    source: 'manual',
    status: { name: 'New' },
    tags: [],
    primaryAgent: null,
    secondaryAgent: null,
    propertyType: 'apartment',
    purpose: 'buy',
    location: '',
    budget: '',
    currency: 'INR',
    builtUpArea: '',
    carpetArea: '',
    readiness: 'ready_to_move',
    nextFollowUpAt: null,
    campaignName: '',
    facebookPageName: '',
    createdAt,
  }])
  assert.match(csv, /Lead #/)
  assert.match(csv, /#1/)
  assert.match(csv, /Lead Created Date/)
  assert.match(csv, /2024-01-01T00:00:00.000Z/)
})

test('toXlsx writes Lead Created Date as real Excel dates with per-lead values', async () => {
  const firstCreated = new Date('2024-02-10T08:15:30.000Z')
  const secondCreated = new Date('2024-03-20T14:45:00.000Z')
  const buffer = await toXlsx([
    {
      label: '#10',
      name: 'First Lead',
      phone: '+971501111111',
      email: '',
      source: 'facebook',
      status: { name: 'New' },
      tags: [],
      primaryAgent: null,
      secondaryAgent: null,
      propertyType: 'apartment',
      purpose: 'buy',
      location: '',
      budget: '',
      currency: 'AED',
      builtUpArea: '',
      carpetArea: '',
      readiness: 'ready_to_move',
      nextFollowUpAt: null,
      campaignName: '',
      facebookPageName: 'India',
      createdAt: firstCreated,
    },
    {
      label: '#11',
      name: 'Second Lead',
      phone: '+971502222222',
      email: '',
      source: 'manual',
      status: { name: 'New' },
      tags: [],
      primaryAgent: null,
      secondaryAgent: null,
      propertyType: 'villa',
      purpose: 'buy',
      location: '',
      budget: '',
      currency: 'AED',
      builtUpArea: '',
      carpetArea: '',
      readiness: 'ready_to_move',
      nextFollowUpAt: null,
      campaignName: '',
      facebookPageName: 'India',
      createdAt: secondCreated,
    },
  ])
  const parsed = await readExcelSheet(buffer)
  assert.ok(parsed.headers.includes('Lead Created Date'))
  assert.equal(parsed.rows.length, 2)
  const first = parsed.rows.find((row) => row[messages.csvName] === 'First Lead')
  const second = parsed.rows.find((row) => row[messages.csvName] === 'Second Lead')
  assert.ok(first[messages.csvCreatedAt] instanceof Date)
  assert.ok(second[messages.csvCreatedAt] instanceof Date)
  assert.equal(first[messages.csvCreatedAt].getTime(), firstCreated.getTime())
  assert.equal(second[messages.csvCreatedAt].getTime(), secondCreated.getTime())
  assert.notEqual(first[messages.csvCreatedAt].getTime(), second[messages.csvCreatedAt].getTime())
  const createdCol = parsed.headers.indexOf('Lead Created Date') + 1
  assert.equal(parsed.sheet.getRow(2).getCell(createdCol).numFmt, 'yyyy-mm-dd hh:mm:ss')
  assert.equal(formatExcelDate(first[messages.csvCreatedAt]), '2024-02-10 08:15:30')
  assert.equal(formatExcelDate(second[messages.csvCreatedAt]), '2024-03-20 14:45:00')
})

test('automatic report Excel attachments include Lead Created Date per Page Type including Unknown', async () => {
  const admin = await registerVerifiedAdmin('XlsxRep')
  const statusId = await defaultStatusId(admin.accessToken)
  const { Lead } = getModels()

  const early = new Date('2024-06-05T09:30:00.000Z')
  const mid = new Date('2024-06-12T16:00:00.000Z')
  const late = new Date('2024-06-20T11:45:15.000Z')

  const indiaEarly = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      name: 'India Early',
      phone: '+971505550001',
      source: 'facebook',
      statusId,
      facebookPageName: 'India',
      facebookPageId: 'india-page',
    })
  assert.equal(indiaEarly.status, 201)
  await Lead.update({ createdAt: early }, { where: { id: indiaEarly.body.data.lead.id } })

  const indiaLate = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      name: 'India Late',
      phone: '+971505550002',
      source: 'facebook',
      statusId,
      facebookPageName: 'India',
      facebookPageId: 'india-page',
    })
  assert.equal(indiaLate.status, 201)
  await Lead.update({ createdAt: late }, { where: { id: indiaLate.body.data.lead.id } })

  const unknownLead = await request(app)
    .post('/api/leads')
    .set('Authorization', `Bearer ${admin.accessToken}`)
    .send({
      name: 'Blank Page Lead',
      phone: '+971505550003',
      source: 'manual',
      statusId,
      facebookPageName: '',
    })
  assert.equal(unknownLead.status, 201)
  await Lead.update({ createdAt: mid }, { where: { id: unknownLead.body.data.lead.id } })

  const built = await buildPageTypeExcelAttachments(
    admin.companyId,
    new Date('2024-06-01T00:00:00.000Z'),
    new Date('2024-06-30T23:59:59.000Z'),
    2024,
    6,
  )
  assert.equal(built.totalLeads, 3)
  assert.equal(built.attachments.length, 2)
  assert.ok(built.attachments.every((item) => item.filename.endsWith('.xlsx')))
  assert.ok(built.attachments.every((item) => item.contentType === EXCEL_CONTENT_TYPE))
  assert.ok(built.attachments.some((item) => item.filename.startsWith('India_Leads_')))
  assert.ok(built.attachments.some((item) => item.filename.startsWith('Unknown_Page_Type_Leads_')))

  const india = built.attachments.find((item) => item.filename.startsWith('India_Leads_'))
  const indiaSheet = await readExcelSheet(india.content)
  assert.ok(indiaSheet.headers.includes('Lead Created Date'))
  const earlyRow = indiaSheet.rows.find((row) => row[messages.csvName] === 'India Early')
  const lateRow = indiaSheet.rows.find((row) => row[messages.csvName] === 'India Late')
  assert.ok(earlyRow)
  assert.ok(lateRow)
  assert.equal(earlyRow[messages.csvCreatedAt].getTime(), early.getTime())
  assert.equal(lateRow[messages.csvCreatedAt].getTime(), late.getTime())
  assert.notEqual(earlyRow[messages.csvCreatedAt].getTime(), lateRow[messages.csvCreatedAt].getTime())

  const unknown = built.attachments.find((item) => item.filename.startsWith('Unknown_Page_Type_Leads_'))
  const unknownSheet = await readExcelSheet(unknown.content)
  assert.ok(unknownSheet.headers.includes('Lead Created Date'))
  const blankRow = unknownSheet.rows.find((row) => row[messages.csvName] === 'Blank Page Lead')
  assert.ok(blankRow)
  assert.equal(blankRow[messages.csvCreatedAt].getTime(), mid.getTime())
})
