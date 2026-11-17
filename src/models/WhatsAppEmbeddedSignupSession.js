const { DataTypes } = require('sequelize')

/**
 * Single-use Embedded Signup nonce sessions (hashed), bound to company + user.
 *
 * @param {import('sequelize').Sequelize} sequelize
 */
function defineWhatsAppEmbeddedSignupSession(sequelize) {
  return sequelize.define('WhatsAppEmbeddedSignupSession', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    userId: { type: DataTypes.CHAR(36), allowNull: false },
    nonceHash: { type: DataTypes.CHAR(64), allowNull: false },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    consumedAt: { type: DataTypes.DATE, allowNull: true },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'pending' },
    requestId: { type: DataTypes.STRING(64), allowNull: true },
    ip: { type: DataTypes.STRING(64), allowNull: true },
  }, { tableName: 'whatsapp_embedded_signup_sessions' })
}

module.exports = { defineWhatsAppEmbeddedSignupSession }
