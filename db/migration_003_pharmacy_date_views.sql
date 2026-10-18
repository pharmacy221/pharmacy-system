-- ============================================================================
-- db/migration_003_pharmacy_date_views.sql
-- تحديث view تنبيه قرب الانتهاء ليستخدم تاريخ الصيدلية (pharmacy_today) بدل CURRENT_DATE
-- (توقيت السيرفر UTC). نفس الأعمدة بالظبط، فمفيش حاجة تانية بتتأثر. idempotent.
-- شغّله بعد migration_002_integrity_fixes.sql.
-- ============================================================================
BEGIN;

CREATE OR REPLACE VIEW near_expiry_batches AS
SELECT b.id AS batch_id, m.id AS medicine_id, m.name, b.batch_number,
       b.expiry_date, b.quantity_units,
       (b.expiry_date - pharmacy_today()) AS days_left
FROM batches b
JOIN medicines m ON m.id = b.medicine_id
WHERE b.quantity_units > 0
  AND b.expiry_date <= (pharmacy_today() + INTERVAL '90 days')
ORDER BY b.expiry_date ASC;

COMMIT;
