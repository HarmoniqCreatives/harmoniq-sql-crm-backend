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
const { defineMetaAppProfile } = require('./MetaAppProfile')
const { defineMetaConnection } = require('./MetaConnection')
const { defineMetaPage } = require('./MetaPage')
const { defineMetaLeadFormSubscription } = require('./MetaLeadFormSubscription')
const { defineMetaOAuthState } = require('./MetaOAuthState')
const { defineMetaWebhookIngestion } = require('./MetaWebhookIngestion')
const { defineMetaSyncJob } = require('./MetaSyncJob')

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
  const MetaAppProfile = defineMetaAppProfile(sequelize)
  const MetaConnection = defineMetaConnection(sequelize)
  const MetaPage = defineMetaPage(sequelize)
  const MetaLeadFormSubscription = defineMetaLeadFormSubscription(sequelize)
  const MetaOAuthState = defineMetaOAuthState(sequelize)
  const MetaWebhookIngestion = defineMetaWebhookIngestion(sequelize)
  const MetaSyncJob = defineMetaSyncJob(sequelize)

  Company.hasMany(Role, { foreignKey: 'companyId' })
  Company.hasMany(User, { foreignKey: 'companyId' })
  Company.hasMany(Session, { foreignKey: 'companyId' })
  Company.hasMany(CatalogItem, { foreignKey: 'companyId' })
  Company.hasMany(Branch, { foreignKey: 'companyId' })
  Company.hasMany(Team, { foreignKey: 'companyId' })
  Company.hasMany(Invitation, { foreignKey: 'companyId' })
  Company.hasMany(Lead, { foreignKey: 'companyId' })
  Company.hasMany(Counter, { foreignKey: 'companyId' })
  Company.hasMany(MetaAppProfile, { foreignKey: 'companyId' })
  Company.hasMany(MetaConnection, { foreignKey: 'companyId' })
  Company.hasMany(MetaPage, { foreignKey: 'companyId' })
  Company.hasMany(MetaLeadFormSubscription, { foreignKey: 'companyId' })
  Company.hasMany(MetaOAuthState, { foreignKey: 'companyId' })
  Company.hasMany(MetaWebhookIngestion, { foreignKey: 'companyId' })
  Company.hasMany(MetaSyncJob, { foreignKey: 'companyId' })

  Role.belongsTo(Company, { foreignKey: 'companyId' })
  Role.hasMany(User, { foreignKey: 'roleId' })
  Role.hasMany(Invitation, { foreignKey: 'roleId' })

  User.belongsTo(Company, { foreignKey: 'companyId' })
  User.belongsTo(Role, { foreignKey: 'roleId' })
  User.belongsTo(Branch, { foreignKey: 'branchId' })
  User.belongsTo(Team, { foreignKey: 'teamId' })
  User.hasMany(Session, { foreignKey: 'userId' })
  User.hasMany(Invitation, { foreignKey: 'invitedBy', as: 'sentInvitations' })

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
    MetaAppProfile,
    MetaConnection,
    MetaPage,
    MetaLeadFormSubscription,
    MetaOAuthState,
    MetaWebhookIngestion,
    MetaSyncJob,
  }
  return models
}

module.exports = { getModels }
