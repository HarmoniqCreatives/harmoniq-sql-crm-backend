const companyStatuses = {
  pendingVerification: 'PENDING_VERIFICATION',
  active: 'ACTIVE',
  disabled: 'DISABLED',
}

const userStatuses = {
  pending: 'PENDING',
  active: 'ACTIVE',
  disabled: 'DISABLED',
}

const invitationStatuses = {
  pending: 'PENDING',
  accepted: 'ACCEPTED',
  revoked: 'REVOKED',
  expired: 'EXPIRED',
}

const emailDeliveryStatuses = {
  pending: 'pending',
  sent: 'sent',
  failed: 'failed',
}

const roleKeys = {
  superAdmin: 'super_admin',
  admin: 'admin',
  manager: 'manager',
  agent: 'agent',
}

const roleScopes = {
  own: 'OWN',
  team: 'TEAM',
  branch: 'BRANCH',
  company: 'COMPANY',
}

// Exists so role authority comparisons stay consistent for privilege-escalation checks.
const roleAuthority = {
  [roleKeys.superAdmin]: 100,
  [roleKeys.admin]: 80,
  [roleKeys.manager]: 50,
  [roleKeys.agent]: 20,
}

const permissionKeys = {
  usersView: 'users.view',
  usersCreate: 'users.create',
  usersEdit: 'users.edit',
  usersDelete: 'users.delete',
  usersInvite: 'users.invite',
  rolesView: 'roles.view',
  rolesCreate: 'roles.create',
  rolesEdit: 'roles.edit',
  rolesDelete: 'roles.delete',
  permissionsManage: 'permissions.manage',
  leadsView: 'leads.view',
  leadsCreate: 'leads.create',
  leadsEdit: 'leads.edit',
  leadsDelete: 'leads.delete',
  leadsAssign: 'leads.assign',
  reportsView: 'reports.view',
  settingsManage: 'settings.manage',
  // Kept for forward-compatible catalog seeds / future modules (not enforced by this module).
  leadsBulk: 'leads.bulk',
  activitiesManage: 'activities.manage',
  templatesManage: 'templates.manage',
  communicationsSend: 'communications.send',
  metaView: 'meta.view',
  metaManage: 'meta.manage',
  metaPagesManage: 'meta.pages.manage',
  whatsappManage: 'whatsapp.manage',
  whatsappViewLogs: 'whatsapp.view_logs',
  auditView: 'audit.view',
  // Legacy alias used by earlier Auth role seeds; map to invite+edit+view bundle in seed sync.
  usersManage: 'users.manage',
  rolesManage: 'roles.manage',
}

const catalogKinds = {
  status: 'STATUS',
  tag: 'TAG',
  activity: 'ACTIVITY',
}

/** Tag/status chip colors. Status and activity use `none` (empty); tags require a color. */
const catalogTones = {
  none: '',
  green: 'green',
  red: 'red',
  amber: 'amber',
  blue: 'blue',
}

const timezones = {
  dubai: 'Asia/Dubai',
  kolkata: 'Asia/Kolkata',
  karachi: 'Asia/Karachi',
}

const currencies = {
  aed: 'AED',
  inr: 'INR',
  pkr: 'PKR',
  usd: 'USD',
  eur: 'EUR',
}

const leadSources = {
  manual: 'manual',
  facebook: 'facebook',
  instagram: 'instagram',
  website: 'website',
}

const propertyTypes = {
  apartment: 'apartment',
  villa: 'villa',
  townhouse: 'townhouse',
  studio: 'studio',
}

const leadPurposes = {
  buy: 'buy',
  rent: 'rent',
}

const readinessValues = {
  readyToMove: 'ready_to_move',
  underConstruction: 'under_construction',
}

const feedbackTypes = {
  general: 'general',
  positive: 'positive',
  concern: 'concern',
  complaint: 'complaint',
  followUpOutcome: 'follow_up_outcome',
}

const leadSorts = {
  createdAt: 'createdAt',
  name: 'name',
  number: 'number',
}

const metaModes = {
  central: 'central',
  customer: 'customer',
}

const metaConnectionStatuses = {
  connected: 'connected',
  disconnected: 'disconnected',
  expired: 'expired',
}

const metaPageStatuses = {
  connected: 'connected',
  disconnected: 'disconnected',
  inaccessible: 'inaccessible',
  expired: 'expired',
}

const metaFormSubscriptionStatuses = {
  active: 'active',
  inactive: 'inactive',
}

const metaWebhookIngestionStatuses = {
  received: 'received',
  pending: 'pending',
  processing: 'processing',
  imported: 'imported',
  skipped: 'skipped',
  failed: 'failed',
  ignored: 'ignored',
}

const metaSyncJobStatuses = {
  pending: 'pending',
  processing: 'processing',
  completed: 'completed',
  failed: 'failed',
}

const emailReportTypes = {
  leadReport: 'lead_report',
}

const emailReportFrequencies = {
  daily: 'daily',
  monthly: 'monthly',
}

const emailReportMonthlySchedules = {
  start: 'start',
  end: 'end',
}

const emailReportDeliveryStatuses = {
  processing: 'processing',
  sent: 'sent',
  failed: 'failed',
  skipped: 'skipped',
}

const whatsappWorkflowKeys = {
  metaAssign: 'meta_assign',
  transfer: 'transfer',
}

const whatsappTokenSources = {
  embeddedSignup: 'embedded_signup',
  manualDev: 'manual_dev',
}

const whatsappEmbeddedSignupStatuses = {
  pending: 'pending',
  consumed: 'consumed',
  expired: 'expired',
  cancelled: 'cancelled',
}

const whatsappPhoneRegistrationStatuses = {
  unregistered: 'unregistered',
  pending: 'pending',
  registered: 'registered',
  failed: 'failed',
}

const whatsappOutboxStatuses = {
  queued: 'queued',
  processing: 'processing',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
}

const whatsappMessageStatuses = {
  queued: 'queued',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  cancelled: 'cancelled',
  skipped: 'skipped',
}

const whatsappAuditActions = {
  configUpdate: 'config_change',
  disconnect: 'disconnect',
  connect: 'connect',
  tokenReplace: 'token_replace',
  templateSync: 'template_sync',
  templateUpdate: 'template_update',
  workflowBinding: 'workflow_binding',
  signupStart: 'embedded_signup_start',
  signupConsume: 'embedded_signup_consume',
  manualDevToken: 'manual_dev_token',
  manualConfigSave: 'manual_config_save',
  connectionVerify: 'connection_verify',
  testMessage: 'test_message',
  phoneRegister: 'phone_register',
  wabaSubscribe: 'waba_subscribe',
  messageEnqueue: 'message_enqueue',
  webhookReceive: 'webhook_receive',
}

const whatsappAuditOutcomes = {
  success: 'success',
  failure: 'failure',
}

/** v1 CRM template body variable keys (Mongo parity baseline). */
const whatsappTemplateVariableKeys = [
  'leadName',
  'leadPhone',
  'campaignName',
  'pageName',
  'facebookPageName',
  'crmLeadLink',
  'agentName',
  'agentPhone',
]

module.exports = {
  companyStatuses,
  userStatuses,
  invitationStatuses,
  emailDeliveryStatuses,
  roleKeys,
  roleScopes,
  roleAuthority,
  permissionKeys,
  catalogKinds,
  catalogTones,
  timezones,
  currencies,
  leadSources,
  propertyTypes,
  leadPurposes,
  readinessValues,
  feedbackTypes,
  leadSorts,
  metaModes,
  metaConnectionStatuses,
  metaPageStatuses,
  metaFormSubscriptionStatuses,
  metaWebhookIngestionStatuses,
  metaSyncJobStatuses,
  emailReportTypes,
  emailReportFrequencies,
  emailReportMonthlySchedules,
  emailReportDeliveryStatuses,
  whatsappWorkflowKeys,
  whatsappTokenSources,
  whatsappEmbeddedSignupStatuses,
  whatsappPhoneRegistrationStatuses,
  whatsappOutboxStatuses,
  whatsappMessageStatuses,
  whatsappAuditActions,
  whatsappAuditOutcomes,
  whatsappTemplateVariableKeys,
}
