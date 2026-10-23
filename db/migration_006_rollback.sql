BEGIN;
DROP TRIGGER IF EXISTS trg_log_price_change ON medicines;
DROP FUNCTION IF EXISTS log_price_change();
DROP TABLE IF EXISTS price_history;
DELETE FROM schema_migrations WHERE name = 'migration_006_price_history.sql';
COMMIT;
