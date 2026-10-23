-- ============================================================================
-- db/migration_007_no_credit_limit.sql
-- إلغاء حد الآجل: البيع الآجل/التقسيط مبقاش بيتحقق من credit_limit (العمود فاضل في الجدول من غير استخدام).
-- idempotent. شغّله بعد migration_006.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION finalize_sale_invoice(p_invoice_id INTEGER, p_discount NUMERIC, p_user_id INTEGER, p_credit NUMERIC DEFAULT 0)
RETURNS NUMERIC
LANGUAGE plpgsql AS $$
DECLARE
  inv sale_invoices%ROWTYPE;
  v_subtotal NUMERIC;
  v_discount NUMERIC;
  v_total NUMERIC;
  v_credit NUMERIC := 0;
  v_cust customers%ROWTYPE;
BEGIN
  SELECT * INTO inv FROM sale_invoices WHERE id = p_invoice_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'الفاتورة غير موجودة' USING ERRCODE = 'PH002';
  END IF;
  IF inv.status <> 'completed' THEN
    RAISE EXCEPTION 'الفاتورة ملغاة' USING ERRCODE = 'PH001';
  END IF;
  IF inv.shift_id IS NULL THEN
    RAISE EXCEPTION 'الفاتورة لازم تكون مرتبطة بوردية' USING ERRCODE = 'PH001';
  END IF;
  IF inv.credit_amount > 0 OR EXISTS (SELECT 1 FROM cash_movements WHERE invoice_id = p_invoice_id AND movement_type = 'sale') THEN
    RAISE EXCEPTION 'الفاتورة اتسجلت قبل كده' USING ERRCODE = 'PH003';
  END IF;

  SELECT COALESCE(SUM(total), 0) INTO v_subtotal FROM sale_items WHERE invoice_id = p_invoice_id;
  IF v_subtotal <= 0 THEN
    RAISE EXCEPTION 'الفاتورة فارغة' USING ERRCODE = 'PH001';
  END IF;

  v_discount := ROUND(LEAST(GREATEST(COALESCE(p_discount, 0), 0), v_subtotal), 2);
  v_total := v_subtotal - v_discount;

  UPDATE sale_invoices SET discount = v_discount, total = v_total WHERE id = p_invoice_id;

  -- البيع الآجل: الجزء غير المدفوع بيتسجل على حساب العميل (مش في الخزنة)
  v_credit := ROUND(LEAST(GREATEST(COALESCE(p_credit, 0), 0), v_total), 2);
  IF v_credit > 0 THEN
    IF inv.customer_id IS NULL THEN
      RAISE EXCEPTION 'البيع الآجل لازم يكون لعميل مسجّل' USING ERRCODE = 'PH001';
    END IF;
    SELECT * INTO v_cust FROM customers WHERE id = inv.customer_id FOR UPDATE;
    IF NOT FOUND OR NOT v_cust.is_active THEN
      RAISE EXCEPTION 'العميل غير موجود أو موقوف' USING ERRCODE = 'PH001';
    END IF;
    PERFORM customer_post(inv.customer_id, 'credit_sale', v_credit, p_invoice_id, inv.shift_id, NULL, NULL, p_user_id);
    UPDATE sale_invoices SET credit_amount = v_credit WHERE id = p_invoice_id;
  END IF;

  IF v_total - v_credit > 0 THEN
    INSERT INTO cash_movements (shift_id, invoice_id, movement_type, method, amount, created_by)
    VALUES (inv.shift_id, p_invoice_id, 'sale', inv.payment_method, v_total - v_credit, p_user_id);
  END IF;
  RETURN v_total;
END;
$$;

COMMIT;
