-- ============================================================================
-- db/migration_006_price_history.sql
-- سجل تغيّر أسعار البيع: أي تعديل في sale_price_unit / sale_price_strip / sale_price_box
-- بيتسجّل تلقائيًا (قبل/بعد + المصدر + مين غيّره) سواء من شاشة الأصناف أو من "الأسعار الرسمية".
-- المصدر والمستخدم بيتبعتوا من التطبيق عن طريق set_config('app.price_source' / 'app.user_id', ..., true).
-- idempotent. شغّله بعد migration_005.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS price_history (
  id BIGSERIAL PRIMARY KEY,
  medicine_id INTEGER NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  medicine_name TEXT,
  old_unit NUMERIC(12,2), new_unit NUMERIC(12,2),
  old_strip NUMERIC(12,2), new_strip NUMERIC(12,2),
  old_box NUMERIC(12,2), new_box NUMERIC(12,2),
  source TEXT NOT NULL DEFAULT 'manual',          -- manual = تعديل يدوي | official = تطبيق السعر الرسمي
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_price_history_med ON price_history (medicine_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_price_history_at ON price_history (changed_at DESC);
ALTER TABLE price_history ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION log_price_change() RETURNS TRIGGER AS $$
DECLARE
  v_src TEXT := COALESCE(NULLIF(current_setting('app.price_source', true), ''), 'manual');
  v_user INTEGER := NULLIF(current_setting('app.user_id', true), '')::int;
BEGIN
  IF NEW.sale_price_unit IS DISTINCT FROM OLD.sale_price_unit
     OR NEW.sale_price_strip IS DISTINCT FROM OLD.sale_price_strip
     OR NEW.sale_price_box IS DISTINCT FROM OLD.sale_price_box THEN
    INSERT INTO price_history (medicine_id, medicine_name, old_unit, new_unit, old_strip, new_strip, old_box, new_box, source, changed_by)
    VALUES (NEW.id, NEW.name, OLD.sale_price_unit, NEW.sale_price_unit, OLD.sale_price_strip, NEW.sale_price_strip,
            OLD.sale_price_box, NEW.sale_price_box, v_src, v_user);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_log_price_change ON medicines;
CREATE TRIGGER trg_log_price_change
AFTER UPDATE OF sale_price_unit, sale_price_strip, sale_price_box ON medicines
FOR EACH ROW EXECUTE FUNCTION log_price_change();

COMMIT;
