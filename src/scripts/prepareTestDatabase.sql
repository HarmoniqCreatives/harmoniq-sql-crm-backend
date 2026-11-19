-- Run as a MySQL admin on local only, then:
--   DB_NAME=harmoniq_creative_crm_test npm run db:migrate
--   DB_NAME_TEST=harmoniq_creative_crm_test npm test
CREATE DATABASE IF NOT EXISTS harmoniq_creative_crm_test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON harmoniq_creative_crm_test.* TO 'harmoniq'@'127.0.0.1';
GRANT ALL PRIVILEGES ON harmoniq_creative_crm_test.* TO 'harmoniq'@'localhost';
FLUSH PRIVILEGES;
