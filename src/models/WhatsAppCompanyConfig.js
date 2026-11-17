const { DataTypes } = require('sequelize')

/**
 * Per-company WhatsApp Cloud API connection (WABA + phone + encrypted token).
 * wabaId / phoneNumberId are globally unique when set; cleared on disconnect.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppCompanyConfig(sequelize) {
  return sequelize.define('WhatsAppCompanyConfig', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    wabaId: { type: DataTypes.STRING(64), allowNull: true },
    phoneNumberId: { type: DataTypes.STRING(64), allowNull: true },
    businessId: { type: DataTypes.STRING(64), allowNull: true },
    displayPhoneNumber: { type: DataTypes.STRING(32), allowNull: true },
    displayName: { type: DataTypes.STRING(160), allowNull: true },
    qualityRating: { type: DataTypes.STRING(32), allowNull: true },
    messagingLimitTier: { type: DataTypes.STRING(64), allowNull: true },
    accessTokenCipher: { type: DataTypes.TEXT, allowNull: true },
    accessTokenIv: { type: DataTypes.STRING(64), allowNull: true },
    accessTokenTag: { type: DataTypes.STRING(64), allowNull: true },
    keyVersion: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
    tokenStored: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    tokenSource: { type: DataTypes.STRING(32), allowNull: true },
    tokenExpiresAt: { type: DataTypes.DATE, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    defaultLanguage: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'en' },
    metaAssignEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    transferEnabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    connectedAt: { type: DataTypes.DATE, allowNull: true },
    lastError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    phoneRegistrationStatus: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'unregistered',
    },
    phoneRegisteredAt: { type: DataTypes.DATE, allowNull: true },
    phoneRegistrationError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    wabaWebhookSubscribed: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    wabaWebhookSubscribedAt: { type: DataTypes.DATE, allowNull: true },
    webhookLastEventAt: { type: DataTypes.DATE, allowNull: true },
    webhookLastError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    templatesLastSyncedAt: { type: DataTypes.DATE, allowNull: true },
    templatesSyncError: { type: DataTypes.STRING(500), allowNull: false, defaultValue: '' },
    registrationLockToken: { type: DataTypes.CHAR(36), allowNull: true },
    registrationLockedAt: { type: DataTypes.DATE, allowNull: true },
    registrationLockExpiresAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.CHAR(36), allowNull: false },
    updatedBy: { type: DataTypes.CHAR(36), allowNull: false },
  }, { tableName: 'whatsapp_company_configs' })
}

module.exports = { defineWhatsAppCompanyConfig }
