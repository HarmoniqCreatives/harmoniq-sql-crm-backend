const { getSequelize } = require('../config/database')
const { defineCompany } = require('./Company')
const { defineRole } = require('./Role')
const { defineUser } = require('./User')
const { defineSession } = require('./Session')
const { defineCatalogItem } = require('./CatalogItem')
const { defineBranch } = require('./Branch')
const { defineTeam } = require('./Team')
const { defineInvitation } = require('./Invitation')
const { defineDialCountry } = require('./DialCountry')
const { defineCounter } = require('./Counter')
const { defineLead } = require('./Lead')
const { defineLeadTag } = require('./LeadTag')
const { defineLeadNote } = require('./LeadNote')
const { defineLeadFeedback } = require('./LeadFeedback')
const { defineLeadTransfer } = require('./LeadTransfer')
const { defineLeadActivity } = require('./LeadActivity')
const { defineLeadImportSession } = require('./LeadImportSession')
const { defineMetaAppProfile } = require('./MetaAppProfile')
const { defineMetaConnection } = require('./MetaConnection')
const { defineMetaPage } = require('./MetaPage')
const { defineMetaLeadFormSubscription } = require('./MetaLeadFormSubscription')
const { defineMetaOAuthState } = require('./MetaOAuthState')
const { defineMetaWebhookIngestion } = require('./MetaWebhookIngestion')
const { defineMetaSyncJob } = require('./MetaSyncJob')
const { defineCompanyEmailReport } = require('./CompanyEmailReport')
const { defineEmailReportDeliveryLog } = require('./EmailReportDeliveryLog')
const { defineWhatsAppCompanyConfig } = require('./WhatsAppCompanyConfig')
const { defineWhatsAppEmbeddedSignupSession } = require('./WhatsAppEmbeddedSignupSession')
const { defineWhatsAppTemplate } = require('./WhatsAppTemplate')
const { defineWhatsAppWorkflowBinding } = require('./WhatsAppWorkflowBinding')
const { defineWhatsAppMessageLog } = require('./WhatsAppMessageLog')
const { defineWhatsAppOutbox } = require('./WhatsAppOutbox')
const { defineWhatsAppWebhookEvent } = require('./WhatsAppWebhookEvent')
const { defineWhatsAppAuditLog } = require('./WhatsAppAuditLog')
const { defineNotification } = require('./Notification')
const { defineUserDeviceToken } = require('./UserDeviceToken')
const { defineNotificationDelivery } = require('./NotificationDelivery')

let models

function getModels() {
  if (models) {
    return models
  }
  const sequelize = getSequelize()
  const Company = defineCompany(sequelize)
  const Role = defineRole(sequelize)
  const User = defineUser(sequelize)
  const Session = defineSession(sequelize)
  const CatalogItem = defineCatalogItem(sequelize)
  const Branch = defineBranch(sequelize)
  const Team = defineTeam(sequelize)
  const Invitation = defineInvitation(sequelize)
  const DialCountry = defineDialCountry(sequelize)
  const Counter = defineCounter(sequelize)
  const Lead = defineLead(sequelize)
  const LeadTag = defineLeadTag(sequelize)
  const LeadNote = defineLeadNote(sequelize)
  const LeadFeedback = defineLeadFeedback(sequelize)
  const LeadTransfer = defineLeadTransfer(sequelize)
  const LeadActivity = defineLeadActivity(sequelize)
  const LeadImportSession = defineLeadImportSession(sequelize)
  const MetaAppProfile = defineMetaAppProfile(sequelize)
  const MetaConnection = defineMetaConnection(sequelize)
  const MetaPage = defineMetaPage(sequelize)
  const MetaLeadFormSubscription = defineMetaLeadFormSubscription(sequelize)
  const MetaOAuthState = defineMetaOAuthState(sequelize)
  const MetaWebhookIngestion = defineMetaWebhookIngestion(sequelize)
  const MetaSyncJob = defineMetaSyncJob(sequelize)
  const CompanyEmailReport = defineCompanyEmailReport(sequelize)
  const EmailReportDeliveryLog = defineEmailReportDeliveryLog(sequelize)
  const WhatsAppCompanyConfig = defineWhatsAppCompanyConfig(sequelize)
  const WhatsAppEmbeddedSignupSession = defineWhatsAppEmbeddedSignupSession(sequelize)
  const WhatsAppTemplate = defineWhatsAppTemplate(sequelize)
  const WhatsAppWorkflowBinding = defineWhatsAppWorkflowBinding(sequelize)
  const WhatsAppMessageLog = defineWhatsAppMessageLog(sequelize)
  const WhatsAppOutbox = defineWhatsAppOutbox(sequelize)
  const WhatsAppWebhookEvent = defineWhatsAppWebhookEvent(sequelize)
  const WhatsAppAuditLog = defineWhatsAppAuditLog(sequelize)
  const Notification = defineNotification(sequelize)
  const UserDeviceToken = defineUserDeviceToken(sequelize)
  const NotificationDelivery = defineNotificationDelivery(sequelize)

  Company.hasMany(Role, { foreignKey: 'companyId' })
  Company.hasMany(User, { foreignKey: 'companyId' })
  Company.hasMany(Session, { foreignKey: 'companyId' })
  Company.hasMany(CatalogItem, { foreignKey: 'companyId' })
  Company.hasMany(Branch, { foreignKey: 'companyId' })
  Company.hasMany(Team, { foreignKey: 'companyId' })
  Company.hasMany(Invitation, { foreignKey: 'companyId' })
  Company.hasMany(Lead, { foreignKey: 'companyId' })
  Company.hasMany(LeadImportSession, { foreignKey: 'companyId' })
  Company.hasMany(Counter, { foreignKey: 'companyId' })
  Company.hasMany(MetaAppProfile, { foreignKey: 'companyId' })
  Company.hasMany(MetaConnection, { foreignKey: 'companyId' })
  Company.hasMany(MetaPage, { foreignKey: 'companyId' })
  Company.hasMany(MetaLeadFormSubscription, { foreignKey: 'companyId' })
  Company.hasMany(MetaOAuthState, { foreignKey: 'companyId' })
  Company.hasMany(MetaWebhookIngestion, { foreignKey: 'companyId' })
  Company.hasMany(MetaSyncJob, { foreignKey: 'companyId' })
  Company.hasMany(CompanyEmailReport, { foreignKey: 'companyId' })
  Company.hasMany(EmailReportDeliveryLog, { foreignKey: 'companyId' })
  Company.hasOne(WhatsAppCompanyConfig, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppEmbeddedSignupSession, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppTemplate, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppWorkflowBinding, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppMessageLog, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppOutbox, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppWebhookEvent, { foreignKey: 'companyId' })
  Company.hasMany(WhatsAppAuditLog, { foreignKey: 'companyId' })
  Company.hasMany(Notification, { foreignKey: 'companyId' })
  Company.hasMany(UserDeviceToken, { foreignKey: 'companyId' })

  Role.belongsTo(Company, { foreignKey: 'companyId' })
  Role.hasMany(User, { foreignKey: 'roleId' })
  Role.hasMany(Invitation, { foreignKey: 'roleId' })

  User.belongsTo(Company, { foreignKey: 'companyId' })
  User.belongsTo(Role, { foreignKey: 'roleId' })
  User.belongsTo(Branch, { foreignKey: 'branchId' })
  User.belongsTo(Team, { foreignKey: 'teamId' })
  User.hasMany(Session, { foreignKey: 'userId' })
  User.hasMany(Invitation, { foreignKey: 'invitedBy', as: 'sentInvitations' })
  User.hasMany(Notification, { foreignKey: 'userId' })
  User.hasMany(UserDeviceToken, { foreignKey: 'userId' })

  Session.belongsTo(User, { foreignKey: 'userId' })
  Session.belongsTo(Company, { foreignKey: 'companyId' })

  CatalogItem.belongsTo(Company, { foreignKey: 'companyId' })

  Branch.belongsTo(Company, { foreignKey: 'companyId' })
  Branch.hasMany(Team, { foreignKey: 'branchId' })
  Branch.hasMany(User, { foreignKey: 'branchId' })

  Team.belongsTo(Company, { foreignKey: 'companyId' })
  Team.belongsTo(Branch, { foreignKey: 'branchId' })
  Team.hasMany(User, { foreignKey: 'teamId' })

  Invitation.belongsTo(Company, { foreignKey: 'companyId' })
  Invitation.belongsTo(Role, { foreignKey: 'roleId' })
  Invitation.belongsTo(Branch, { foreignKey: 'branchId' })
  Invitation.belongsTo(Team, { foreignKey: 'teamId' })
  Invitation.belongsTo(User, { foreignKey: 'invitedBy', as: 'inviter' })

  Lead.belongsTo(Company, { foreignKey: 'companyId' })
  Lead.belongsTo(CatalogItem, { foreignKey: 'statusId', as: 'status' })
  Lead.belongsTo(User, { foreignKey: 'primaryAgentId', as: 'primaryAgent' })
  Lead.belongsTo(User, { foreignKey: 'secondaryAgentId', as: 'secondaryAgent' })
  Lead.belongsTo(Branch, { foreignKey: 'branchId' })
  Lead.belongsTo(Team, { foreignKey: 'teamId' })
  Lead.hasMany(LeadTag, { foreignKey: 'leadId', as: 'tagRows' })
  Lead.hasMany(LeadNote, { foreignKey: 'leadId', as: 'notes' })
  Lead.hasMany(LeadFeedback, { foreignKey: 'leadId', as: 'feedbacks' })
  Lead.hasMany(LeadTransfer, { foreignKey: 'leadId', as: 'transfers' })
  Lead.hasMany(LeadActivity, { foreignKey: 'leadId', as: 'activities' })
  Lead.belongsTo(LeadImportSession, { foreignKey: 'importSessionId', as: 'importSession' })

  LeadImportSession.belongsTo(Company, { foreignKey: 'companyId' })
  LeadImportSession.belongsTo(User, { foreignKey: 'userId', as: 'initiator' })
  LeadImportSession.hasMany(Lead, { foreignKey: 'importSessionId', as: 'importedLeads' })

  LeadTag.belongsTo(Lead, { foreignKey: 'leadId' })
  LeadTag.belongsTo(CatalogItem, { foreignKey: 'tagId', as: 'tag' })
  LeadNote.belongsTo(Lead, { foreignKey: 'leadId' })
  LeadNote.belongsTo(User, { foreignKey: 'createdBy', as: 'author' })
  LeadFeedback.belongsTo(Lead, { foreignKey: 'leadId' })
  LeadTransfer.belongsTo(Lead, { foreignKey: 'leadId' })
  LeadActivity.belongsTo(Lead, { foreignKey: 'leadId' })
  LeadActivity.belongsTo(CatalogItem, { foreignKey: 'activityTypeId', as: 'activityType' })
  LeadActivity.belongsTo(User, { foreignKey: 'agentId', as: 'agent' })

  Counter.belongsTo(Company, { foreignKey: 'companyId' })

  MetaAppProfile.belongsTo(Company, { foreignKey: 'companyId' })
  MetaAppProfile.hasMany(MetaConnection, { foreignKey: 'appProfileId' })
  MetaAppProfile.hasMany(MetaOAuthState, { foreignKey: 'appProfileId' })

  MetaConnection.belongsTo(Company, { foreignKey: 'companyId' })
  MetaConnection.belongsTo(MetaAppProfile, { foreignKey: 'appProfileId' })
  MetaConnection.hasMany(MetaPage, { foreignKey: 'connectionId' })
  MetaConnection.hasMany(MetaLeadFormSubscription, { foreignKey: 'connectionId' })

  MetaPage.belongsTo(Company, { foreignKey: 'companyId' })
  MetaPage.belongsTo(MetaConnection, { foreignKey: 'connectionId' })
  MetaPage.belongsTo(MetaAppProfile, { foreignKey: 'appProfileId' })
  MetaPage.hasMany(MetaLeadFormSubscription, { foreignKey: 'metaPageId' })
  MetaPage.hasMany(MetaWebhookIngestion, { foreignKey: 'metaPageId' })
  MetaPage.hasMany(MetaSyncJob, { foreignKey: 'metaPageId' })

  MetaLeadFormSubscription.belongsTo(Company, { foreignKey: 'companyId' })
  MetaLeadFormSubscription.belongsTo(MetaPage, { foreignKey: 'metaPageId' })
  MetaLeadFormSubscription.belongsTo(MetaConnection, { foreignKey: 'connectionId' })

  MetaOAuthState.belongsTo(Company, { foreignKey: 'companyId' })
  MetaOAuthState.belongsTo(MetaAppProfile, { foreignKey: 'appProfileId' })
  MetaOAuthState.belongsTo(MetaConnection, { foreignKey: 'connectionId' })

  MetaWebhookIngestion.belongsTo(Company, { foreignKey: 'companyId' })
  MetaWebhookIngestion.belongsTo(MetaPage, { foreignKey: 'metaPageId' })
  MetaWebhookIngestion.belongsTo(MetaConnection, { foreignKey: 'connectionId' })
  MetaWebhookIngestion.belongsTo(Lead, { foreignKey: 'leadId' })

  MetaSyncJob.belongsTo(Company, { foreignKey: 'companyId' })
  MetaSyncJob.belongsTo(MetaPage, { foreignKey: 'metaPageId' })

  CompanyEmailReport.belongsTo(Company, { foreignKey: 'companyId' })
  EmailReportDeliveryLog.belongsTo(Company, { foreignKey: 'companyId' })
  EmailReportDeliveryLog.belongsTo(CompanyEmailReport, { foreignKey: 'reportId', as: 'report' })

  WhatsAppCompanyConfig.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppEmbeddedSignupSession.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppEmbeddedSignupSession.belongsTo(User, { foreignKey: 'userId' })

  WhatsAppTemplate.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppTemplate.hasMany(WhatsAppWorkflowBinding, { foreignKey: 'templateId' })

  WhatsAppWorkflowBinding.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppWorkflowBinding.belongsTo(WhatsAppTemplate, { foreignKey: 'templateId', as: 'template' })

  WhatsAppMessageLog.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppMessageLog.belongsTo(WhatsAppTemplate, { foreignKey: 'templateId', as: 'template' })
  WhatsAppMessageLog.hasOne(WhatsAppOutbox, { foreignKey: 'messageLogId', as: 'outbox' })

  WhatsAppOutbox.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppOutbox.belongsTo(WhatsAppMessageLog, { foreignKey: 'messageLogId', as: 'messageLog' })

  WhatsAppWebhookEvent.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppAuditLog.belongsTo(Company, { foreignKey: 'companyId' })
  WhatsAppAuditLog.belongsTo(User, { foreignKey: 'actorUserId', as: 'actor' })

  Notification.belongsTo(Company, { foreignKey: 'companyId' })
  Notification.belongsTo(User, { foreignKey: 'userId' })
  Notification.hasMany(NotificationDelivery, { foreignKey: 'notificationId', as: 'deliveries' })

  UserDeviceToken.belongsTo(Company, { foreignKey: 'companyId' })
  UserDeviceToken.belongsTo(User, { foreignKey: 'userId' })
  UserDeviceToken.hasMany(NotificationDelivery, { foreignKey: 'deviceTokenId', as: 'deliveries' })

  NotificationDelivery.belongsTo(Notification, { foreignKey: 'notificationId', as: 'notification' })
  NotificationDelivery.belongsTo(UserDeviceToken, { foreignKey: 'deviceTokenId', as: 'deviceToken' })

  models = {
    sequelize,
    Sequelize: require('sequelize').Sequelize,
    Company,
    Role,
    User,
    Session,
    CatalogItem,
    Branch,
    Team,
    Invitation,
    DialCountry,
    Counter,
    Lead,
    LeadTag,
    LeadNote,
    LeadFeedback,
    LeadTransfer,
    LeadActivity,
    LeadImportSession,
    MetaAppProfile,
    MetaConnection,
    MetaPage,
    MetaLeadFormSubscription,
    MetaOAuthState,
    MetaWebhookIngestion,
    MetaSyncJob,
    CompanyEmailReport,
    EmailReportDeliveryLog,
    WhatsAppCompanyConfig,
    WhatsAppEmbeddedSignupSession,
    WhatsAppTemplate,
    WhatsAppWorkflowBinding,
    WhatsAppMessageLog,
    WhatsAppOutbox,
    WhatsAppWebhookEvent,
    WhatsAppAuditLog,
    Notification,
    UserDeviceToken,
    NotificationDelivery,
  }
  return models
}

module.exports = { getModels }
