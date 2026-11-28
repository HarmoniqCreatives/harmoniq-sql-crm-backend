'use strict'

const multer = require('multer')
const leadImportService = require('../../services/leadImportService')
const { IMPORT_MAX_FILE_BYTES } = require('../../services/leadImportConstants')
const { AppError, errors } = require('../../utils/errors')

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMPORT_MAX_FILE_BYTES, files: 1 },
  fileFilter(_req, file, cb) {
    const name = String(file.originalname || '').toLowerCase()
    if (!name.endsWith('.xlsx')) {
      cb(new AppError(errors.leadImportFileTypeInvalid, 400))
      return
    }
    cb(null, true)
  },
})

/** Multer middleware for a single `file` field. */
const uploadImportFile = upload.single('file')

async function getLeadImportTemplate(_req, res) {
  const result = await leadImportService.downloadTemplate()
  res.setHeader('Content-Type', result.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
  res.status(200).send(result.buffer)
}

async function postLeadImportSession(req, res) {
  const sheetRaw = req.body?.sheetIndex
  const headerRaw = req.body?.headerRow
  const options = {}
  if (sheetRaw !== undefined && sheetRaw !== null && String(sheetRaw).trim() !== '') {
    options.sheetIndex = Number(sheetRaw)
  }
  if (headerRaw !== undefined && headerRaw !== null && String(headerRaw).trim() !== '') {
    options.headerRow = Number(headerRaw)
  }
  const result = await leadImportService.createSession(req.auth, req.file, options)
  res.status(201).json({ data: result })
}

async function postLeadImportValidate(req, res) {
  const result = await leadImportService.validateSession(req.auth, req.params.id, req.body || {})
  res.status(200).json({ data: result })
}

async function postLeadImportConfirm(req, res) {
  const result = await leadImportService.confirmSession(req.auth, req.params.id, req.body || {})
  res.status(200).json({ data: result })
}

async function getLeadImportSession(req, res) {
  const result = await leadImportService.getSession(req.auth, req.params.id)
  res.status(200).json({ data: result })
}

async function getLeadImportErrors(req, res) {
  const result = await leadImportService.buildErrorReport(req.auth, req.params.id)
  res.setHeader('Content-Type', result.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`)
  res.status(200).send(result.buffer)
}

module.exports = {
  uploadImportFile,
  getLeadImportTemplate,
  postLeadImportSession,
  postLeadImportValidate,
  postLeadImportConfirm,
  getLeadImportSession,
  getLeadImportErrors,
}
