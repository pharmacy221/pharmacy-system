-- ============================================================================
-- db/migration_012_supplier_settle.sql
-- فاتورة شراء مع تسوية المديونية القديمة:
--   لو المدفوع أكبر من إجمالي الفاتورة الجديدة، الزيادة بتتخصم تلقائيًا من فواتير المورد القديمة
--   غير المسددة (الأقدم أولًا). لو الزيادة أكبر من مديونيته القديمة كلها، العملية بتترفض بالكامل.
--   مثال: فاتورة 350، مدفوع 500، المورد له 200 قديمة → الجديدة تتسدد 350، والقديمة تتسدد منها 150 (يفضل 50).
-- بتبني على create_purchase_invoice و record_supplier_payment الموجودين (مفيش تعديل فيهم).
-- آمن لإعادة التشغيل.
-- ============================================================================
BEGIN;

CREATE OR REPLACE FUNCTION create_purchase_invoice_settle(
  p_supplier_id INTEGER, p_invoice_number TEXT, p_invoice_date DATE, p_due_date DATE, p_notes TEXT,
  p_user_id INTEGER, p_username TEXT, p_items JSONB, p_paid NUMERIC DEFAULT 0, p_method TEXT DEFAULT 'cash',
  p_idempotency_key TEXT DEFAULT NULL, p_discount_percent NUMERIC DEFAULT 0
) RETURNS JSONB
LANGUAGE plpgsql AS $$
DECLARE
  v_id INTEGER;
  v_inv purchase_invoices;
  v_paid NUMERIC := ROUND(COALESCE(p_paid, 0), 2);
  v_now NUMERIC;
  v_excess NUMERIC;
  v_old NUMERIC;
  v_alloc JSONB := '[]'::jsonb;
BEGIN
  IF v_paid < 0 THEN
    RAISE EXCEPTION 'المبلغ المدفوع لا يمكن أن يكون سالبًا' USING ERRCODE = 'PH001';
  END IF;

  -- الفاتورة تتسجل الأول من غير دفع (الدالة الأصلية بتحسب الإجمالي بالخصومات)
  v_id := create_purchase_invoice(p_supplier_id, p_invoice_number, p_invoice_date, p_due_date, p_notes,
                                  p_user_id, p_username, p_items, 0, p_method, p_idempotency_key, p_discount_percent);
  SELECT * INTO v_inv FROM purchase_invoices WHERE id = v_id FOR UPDATE;

  v_now := LEAST(v_paid, v_inv.total_amount);
  v_excess := v_paid - v_now;

  IF v_now > 0 THEN
    PERFORM _apply_supplier_payment(v_inv, v_now, p_method, 'دفعة وقت الاستلام', p_user_id);
  END IF;

  IF v_excess > 0 THEN
    SELECT COALESCE(SUM(total_amount - paid_amount), 0) INTO v_old
    FROM purchase_invoices
    WHERE supplier_id = p_supplier_id AND status = 'received' AND id <> v_id AND paid_amount < total_amount;

    IF v_excess > v_old THEN
      RAISE EXCEPTION 'المدفوع (%) أكبر من إجمالي الفاتورة (%) + مديونية المورد القديمة (%)', v_paid, v_inv.total_amount, v_old
        USING ERRCODE = 'PH001';
    END IF;

    -- بتتوزع على الأقدم أولًا (الفاتورة الجديدة مسددة بالكامل فمش داخلة)
    v_alloc := record_supplier_payment(p_supplier_id, NULL, v_excess, p_method,
                                       'سداد من فاتورة الشراء رقم ' || v_id, p_user_id, p_username);
  END IF;

  RETURN jsonb_build_object('invoice_id', v_id, 'paid_new', v_now, 'paid_old', v_excess, 'allocations', v_alloc);
END $$;

COMMIT;
