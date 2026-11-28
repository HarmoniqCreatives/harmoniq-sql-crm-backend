'use strict'

const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024
const IMPORT_MAX_ROWS = 5000
const IMPORT_NOTES_COUNT = 10

/** Canonical CRM import field keys (mapping targets). */
const IMPORT_FIELDS = {
  name: 'name',
  phone: 'phone',
  alternatePhone: 'alternatePhone',
  email: 'email',
  source: 'source',
  subSource: 'subSource',
  agencyName: 'agencyName',
  status: 'status',
  statusReason: 'statusReason',
  receivedOn: 'receivedOn',
  assignedAgent: 'assignedAgent',
  facebookPageName: 'facebookPageName',
  facebookAdName: 'facebookAdName',
  facebookAdSetName: 'facebookAdSetName',
  facebookCampaignName: 'facebookCampaignName',
  tags: 'tags',
}

for (let i = 1; i <= IMPORT_NOTES_COUNT; i += 1) {
  IMPORT_FIELDS[`note${i}`] = `note${i}`
  IMPORT_FIELDS[`note${i}AddedOn`] = `note${i}AddedOn`
  IMPORT_FIELDS[`note${i}AddedBy`] = `note${i}AddedBy`
}

const FIELD_LABELS = {
  name: 'Name',
  phone: 'Contact No',
  alternatePhone: 'Alternate Contact No',
  email: 'Email',
  source: 'Lead Source',
  subSource: 'Sub Source',
  agencyName: 'Agency Name',
  status: 'Status',
  statusReason: 'Status Reason',
  receivedOn: 'Received On',
  assignedAgent: 'Assigned Agent',
  facebookPageName: 'Facebook Page Name',
  facebookAdName: 'Facebook Ad Name',
  facebookAdSetName: 'Facebook Ad Set Name',
  facebookCampaignName: 'Facebook Campaign Name',
  tags: 'Tags',
}

for (let i = 1; i <= IMPORT_NOTES_COUNT; i += 1) {
  FIELD_LABELS[`note${i}`] = `Lead note ${i} (history)`
  FIELD_LABELS[`note${i}AddedOn`] = `Lead note ${i} Added On`
  FIELD_LABELS[`note${i}AddedBy`] = `Lead note ${i} Added By`
}

/** Mapping targets that must be assigned before validate. */
const REQUIRED_IMPORT_FIELDS = ['name', 'phone', 'status']

/**
 * Human-readable required/optional metadata for the mapping UI.
 * Notes map to lead_notes timeline entries — not Lead scalar columns.
 */
function describeImportField(field) {
  if (REQUIRED_IMPORT_FIELDS.includes(field)) {
    return { required: true, group: 'required' }
  }
  if (/^note\d+/.test(field)) {
    return { required: false, group: 'notes' }
  }
  return { required: false, group: 'optional' }
}

/** Normalized header → field synonyms for auto-mapping. */
const HEADER_SYNONYMS = {
  name: ['name', 'lead name', 'full name', 'customer name', 'contact name'],
  phone: ['phone', 'contact no', 'contact number', 'mobile', 'mobile no', 'primary phone', 'phone number'],
  alternatePhone: ['alternate contact no', 'alternate phone', 'alt phone', 'secondary phone', 'alternate number'],
  email: ['email', 'email address', 'e-mail'],
  source: ['lead source', 'source'],
  subSource: ['sub source', 'subsource', 'sub-source'],
  agencyName: ['agency name', 'agency'],
  status: ['status', 'lead status'],
  statusReason: ['status reason', 'reason'],
  receivedOn: ['received on', 'received date', 'received at', 'lead received on'],
  assignedAgent: ['assigned agent', 'agent', 'primary agent', 'owner', 'assigned to'],
  facebookPageName: ['facebook page name', 'facebook name', 'page name', 'fb page'],
  facebookAdName: ['facebook ad name', 'ad name', 'fb ad'],
  facebookAdSetName: ['facebook ad set name', 'ad set name', 'adset name', 'fb ad set'],
  facebookCampaignName: ['facebook campaign name', 'campaign name', 'fb campaign'],
  tags: ['tags', 'tag', 'lead tags'],
}

for (let i = 1; i <= IMPORT_NOTES_COUNT; i += 1) {
  HEADER_SYNONYMS[`note${i}`] = [
    `notes ${i}`,
    `note ${i}`,
    `lead note ${i}`,
    `lead note ${i} (history)`,
  ]
  HEADER_SYNONYMS[`note${i}AddedOn`] = [
    `notes ${i} added on`,
    `note ${i} added on`,
    `notes ${i} date`,
    `lead note ${i} added on`,
  ]
  HEADER_SYNONYMS[`note${i}AddedBy`] = [
    `notes ${i} added by`,
    `note ${i} added by`,
    `notes ${i} author`,
    `lead note ${i} added by`,
  ]
}

const SOURCE_LABEL_MAP = {
  manual: 'manual',
  facebook: 'facebook',
  fb: 'facebook',
  meta: 'facebook',
  instagram: 'instagram',
  ig: 'instagram',
  website: 'website',
  web: 'website',
}

module.exports = {
  IMPORT_MAX_FILE_BYTES,
  IMPORT_MAX_ROWS,
  IMPORT_NOTES_COUNT,
  IMPORT_FIELDS,
  FIELD_LABELS,
  HEADER_SYNONYMS,
  SOURCE_LABEL_MAP,
  REQUIRED_IMPORT_FIELDS,
  describeImportField,
}
