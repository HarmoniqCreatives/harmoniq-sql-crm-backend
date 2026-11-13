-- Run once with: sudo mysql --protocol=socket < backend/scripts/create-database.sql
-- Safe: creates DB if missing; does not drop data.

CREATE DATABASE IF NOT EXISTS harmoniq_creative_crm
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

GRANT ALL PRIVILEGES ON harmoniq_creative_crm.* TO 'harmoniq'@'localhost';
GRANT ALL PRIVILEGES ON harmoniq_creative_crm.* TO 'harmoniq'@'127.0.0.1';
FLUSH PRIVILEGES;

SHOW DATABASES LIKE 'harmoniq_creative_crm';
