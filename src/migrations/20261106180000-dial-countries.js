'use strict'

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('dial_countries', {
      id: { type: Sequelize.CHAR(36), allowNull: false, primaryKey: true },
      name: { type: Sequelize.STRING(120), allowNull: false, unique: true },
      code: { type: Sequelize.STRING(8), allowNull: false },
      sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    })
    await queryInterface.addIndex('dial_countries', ['isActive', 'sortOrder'], {
      name: 'dial_countries_active_sort_idx',
    })

    const now = new Date()
    const { v4: uuidv4 } = require('uuid')
    const rows = [
      { name: 'India', code: '+91', sortOrder: 1 },
      { name: 'USA', code: '+1', sortOrder: 2 },
      { name: 'United Arab Emirates', code: '+971', sortOrder: 3 },
      { name: 'Pakistan', code: '+92', sortOrder: 4 },
      { name: 'United Kingdom', code: '+44', sortOrder: 5 },
      { name: 'Saudi Arabia', code: '+966', sortOrder: 6 },
      { name: 'Canada', code: '+1', sortOrder: 7 },
      { name: 'Australia', code: '+61', sortOrder: 8 },
      { name: 'Singapore', code: '+65', sortOrder: 9 },
      { name: 'Qatar', code: '+974', sortOrder: 10 },
      { name: 'Oman', code: '+968', sortOrder: 11 },
      { name: 'Bahrain', code: '+973', sortOrder: 12 },
      { name: 'Kuwait', code: '+965', sortOrder: 13 },
    ].map((row) => ({
      id: uuidv4(),
      ...row,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    }))
    await queryInterface.bulkInsert('dial_countries', rows)
  },

  async down(queryInterface) {
    await queryInterface.dropTable('dial_countries')
  },
}
