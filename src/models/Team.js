const { DataTypes } = require('sequelize')

/**
 * Team under a branch within a company.
 *
 * Assignment rule: when a user/invite sets both branchId and teamId,
 * `team.branchId` must equal the selected branch (same company).
 *
 * @param {import('sequelize').Sequelize} sequelize
 * @returns {import('sequelize').ModelStatic}
 */
function defineTeam(sequelize) {
  return sequelize.define('Team', {
    id: { type: DataTypes.CHAR(36), primaryKey: true },
    companyId: { type: DataTypes.CHAR(36), allowNull: false },
    branchId: { type: DataTypes.CHAR(36), allowNull: false },
    name: { type: DataTypes.STRING(120), allowNull: false },
    nameKey: { type: DataTypes.STRING(140), allowNull: false },
    managerUserId: { type: DataTypes.CHAR(36), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  }, {
    tableName: 'teams',
  })
}

module.exports = { defineTeam }
