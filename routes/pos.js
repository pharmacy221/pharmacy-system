// routes/pos.js
// شاشة الكاشير: بحث عن صنف بالاسم/الباركود، اختيار وحدة البيع (حبة / شريط / علبة)
// مع اقتراح ذكي "ينفع تاخد شريط بدل الحبايد" (upsell) وقفل بيع عند نقص المخزون.
const express = require('express');
const { query, queryOne, getClient } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { saleLevels } = require('../lib/drug-form');
const { BusinessError, isBusinessError, statusFor, userMessage, cleanKey } = require('../lib/errors');

const router = express.Router();
router.use(requireLogin);

// شاشة الكاشير
router.get('/', async (req, res, next) => {
  try {
    const activeShift = await queryOne(
      'SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL',
      [req.session.userId]
    );
    res.render('pos', { activeShift, active: 'pos' });
  } catch (err) {
    next(err);
  }
});

// يضيف لكل صنف وحدات البيع المسموحة (حبة/شريط/علبة أو حقنة/شراب/بخاخة...) + اسم الشكل
function withLevels(m) {
  const info = saleLevels(m);
  return { ...m, levels: info.levels, default_level: info.defaultLevel, form_label: info.formLabel, single: info.single };
}

// الكمية اللي تتباع فعلاً = مجموع التشغيلات الصالحة (غير المنتهية) بتاريخ الصيدلية المحلي.
// شاشة الكاشير بتعرضها في stock_units عشان الكاشير ميشوفش مخزون منتهي على إنه متاح.
async function withSellableStock(rows) {
  if (!rows.length) return rows;
  const sums = await query(
    `SELECT medicine_id, SUM(quantity_units)::int AS units
     FROM batches
     WHERE medicine_id = ANY($1::int[]) AND quantity_units > 0 AND expiry_date >= pharmacy_today()
     GROUP BY medicine_id`,
    [rows.map((r) => r.id)]
  );
  const byId = new Map(sums.map((r) => [r.medicine_id, r.units]));
  return rows.map((r) => ({ ...r, stock_total_units: r.stock_units, stock_units: byId.get(r.id) || 0 }));
}

const SELLABLE_EXISTS = `EXISTS (SELECT 1 FROM batches b WHERE b.medicine_id = medicines.id AND b.quantity_units > 0 AND b.expiry_date >= pharmacy_today())`;

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

// البحث الفوري (اسم تجاري / مادة فعالة / باركود). كل كلمة لازم تتلاقي في الاسم أو المادة الفعالة.
// ?instock=1 يعرض المتاح بس. المتاح بيظهر الأول دايمًا.
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    const instock = req.query.instock === '1';

    const terms = q.split(/\s+/).filter(Boolean).slice(0, 5);
    const params = [q];
    const conds = terms.map((t) => {
      params.push(`%${escapeLike(t)}%`);
      return `(name ILIKE $${params.length} OR generic_name ILIKE $${params.length})`;
    });
    params.push(`${escapeLike(q)}%`);
    const prefix = `$${params.length}`;

    const rows = await query(
      `SELECT * FROM medicines
       WHERE is_active = true ${instock ? `AND ${SELLABLE_EXISTS}` : ''}
         AND (barcode = $1 OR (${conds.join(' AND ')}))
       ORDER BY (barcode = $1) DESC, (${SELLABLE_EXISTS}) DESC, (name ILIKE ${prefix}) DESC, lower(name)
       LIMIT 40`,
      params
    );
    res.json({ results: (await withSellableStock(rows)).map(withLevels) });
  } catch (err) {
    next(err);
  }
});

// بدائل صنف: نفس المادة الفعالة والمتاحة في المخزون
router.get('/alternatives', async (req, res, next) => {
  try {
    const m = await queryOne('SELECT id, name, generic_name FROM medicines WHERE id = $1', [parseInt(req.query.id) || 0]);
    if (!m || !m.generic_name) return res.json({ results: [], base: m ? m.name : null });
    const rows = await query(
      `SELECT * FROM medicines
       WHERE is_active = true AND id <> $1 AND generic_name = $2
       ORDER BY (${SELLABLE_EXISTS}) DESC, sale_price_box ASC NULLS LAST, lower(name) LIMIT 40`,
      [m.id, m.generic_name]
    );
    res.json({ results: (await withSellableStock(rows)).map(withLevels), base: m.name });
  } catch (err) {
    next(err);
  }
});

// البحث المباشر بالباركود (سكانر)
router.get('/lookup', async (req, res, next) => {
  try {
    const barcode = (req.query.barcode || '').trim();
    if (!barcode) return res.json({ found: false });

    const medicine = await queryOne('SELECT * FROM medicines WHERE barcode = $1 AND is_active = true', [barcode]);
    if (!medicine) return res.json({ found: false });

    const [sellable] = await withSellableStock([medicine]);
    res.json({ found: true, medicine: withLevels(sellable) });
  } catch (err) {
    next(err);
  }
});

// التحقق من كوبون (معاينة بدون استخدامه فعلياً)
router.get('/coupon-check', async (req, res, next) => {
  try {
    const code = (req.query.code || '').trim().toUpperCase();
    const subtotal = parseFloat(req.query.subtotal) || 0;
    if (!code) return res.json({ valid: false, message: 'اكتب كود الكوبون' });

    const coupon = await queryOne('SELECT * FROM coupons WHERE code = $1', [code]);
    if (!coupon) return res.json({ valid: false, message: 'الكوبون غير موجود' });
    if (!coupon.active) return res.json({ valid: false, message: 'الكوبون متوقف' });
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.json({ valid: false, message: 'الكوبون منتهي الصلاحية' });
    }

    let discountAmount = 0;
    if (coupon.discount_percent) {
      discountAmount = (subtotal * Number(coupon.discount_percent)) / 100;
    } else if (coupon.discount_amount) {
      discountAmount = Number(coupon.discount_amount);
    }
    discountAmount = Math.min(discountAmount, subtotal);

    res.json({ valid: true, coupon: { code: coupon.code }, discount_amount: discountAmount });
  } catch (err) {
    next(err);
  }
});

// تسجيل عملية بيع وخصم المخزون (FEFO من التشغيلات الصالحة فقط).
// خصم المخزون والتحويل بين الوحدات بيتم جوه الـ DB triggers (migration_002) في نفس الـ transaction،
// وإجمالي الفاتورة والخصم بيتحسبوا في قاعدة البيانات من البنود (finalize_sale_invoice).
router.post('/checkout', async (req, res) => {
  const { items, customer_name, customer_phone, payment_method, discount_amount, coupon_code, notes } = req.body;
  const idemKey = cleanKey(req.body.idempotency_key || req.get('Idempotency-Key'));

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة' });
  }
  if (items.length > 200) {
    return res.status(400).json({ error: 'عدد الأصناف في الفاتورة كبير جدًا' });
  }

  const userId = req.session.userId;
  const client = await getClient();
  let began = false;

  try {
    // أرقام الأصناف لازم تكون صحيحة (بنقفلها كلها مرة واحدة بترتيب الرقم عشان نتجنب deadlock بين كاشيرين)
    const ids = [...new Set(items.map((i) => parseInt(i && i.medicine_id, 10)))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) throw new BusinessError('بيانات الصنف غير صحيحة');

    await client.query('BEGIN');
    began = true;

    // لازم وردية مفتوحة قبل أي عملية بيع (FOR SHARE: إغلاق الوردية بيستنى لحد ما البيع يخلص)
    const activeShiftResult = await client.query(
      'SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL FOR SHARE',
      [userId]
    );
    if (activeShiftResult.rows.length === 0) {
      throw new BusinessError('يجب فتح وردية أولاً قبل إجراء عملية البيع');
    }
    const shiftId = activeShiftResult.rows[0].id;

    // نفس الطلب اتبعت قبل كده؟ (ضغطة مزدوجة / إعادة إرسال بعد انقطاع) نرجّع نفس الفاتورة من غير بيع تاني
    if (idemKey) {
      const dup = await client.query('SELECT id FROM sale_invoices WHERE idempotency_key = $1 AND created_by = $2', [idemKey, userId]);
      if (dup.rows[0]) {
        await client.query('ROLLBACK');
        began = false;
        return res.json({ ok: true, invoiceId: dup.rows[0].id, duplicate: true });
      }
    }

    // خصم الكوبون (لو موجود)
    let appliedCoupon = null;
    if (coupon_code && String(coupon_code).trim()) {
      const code = String(coupon_code).trim().toUpperCase();
      const couponResult = await client.query('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [code]);
      const coupon = couponResult.rows[0];
      if (!coupon) throw new BusinessError('الكوبون غير موجود');
      if (!coupon.active) throw new BusinessError('الكوبون متوقف');
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) throw new BusinessError('الكوبون منتهي الصلاحية');
      appliedCoupon = coupon;
    }

    const manualDiscount = Math.max(parseFloat(discount_amount) || 0, 0); // مينفعش الخصم يبقى بالسالب

    // احتياج للتحقق من وجود روشتة لأي صنف يستلزمها (تنبيه فقط، مش قفل صارم)
    let requiresPrescriptionWarning = false;

    const medResult = await client.query('SELECT * FROM medicines WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]);
    const medicines = new Map(medResult.rows.map((m) => [m.id, m]));

    // إنشاء رأس الفاتورة (الخصم والإجمالي النهائيين بيتحسبوا في finalize_sale_invoice بعد إدخال البنود)
    const invoiceResult = await client.query(
      `INSERT INTO sale_invoices (customer_name, customer_phone, discount, payment_method, notes, created_by, shift_id, idempotency_key)
       VALUES ($1, $2, 0, $3, $4, $5, $6, $7) RETURNING id`,
      [
        customer_name && customer_name.trim() ? customer_name.trim() : null,
        customer_phone && customer_phone.trim() ? customer_phone.trim() : null,
        ['cash', 'card', 'other'].includes(payment_method) ? payment_method : 'cash',
        notes || null,
        userId,
        shiftId,
        idemKey
      ]
    );
    const invoiceId = invoiceResult.rows[0].id;

    let subtotal = 0;

    for (const item of items) {
      const medicine = medicines.get(parseInt(item.medicine_id, 10));
      if (!medicine) throw new BusinessError(`الصنف رقم ${item.medicine_id} غير موجود`);
      if (!medicine.is_active) throw new BusinessError(`الصنف "${medicine.name}" غير مفعّل`);

      // الوحدة لازم تكون من وحدات الصنف (مثلاً الشراب/الحقنة ملهمش شريط)
      const lv = saleLevels(medicine);
      const chosen = lv.levels.find((l) => l.key === item.sale_unit) || lv.levels.find((l) => l.key === lv.defaultLevel) || lv.levels[0];
      const saleUnit = chosen.key;
      const unitLabel = chosen.label;
      const quantity = Math.max(parseInt(item.quantity, 10) || 1, 1);
      if (quantity > 100000) throw new BusinessError('الكمية كبيرة جدًا');

      let unitPrice;
      if (saleUnit === 'unit') unitPrice = Number(medicine.sale_price_unit);
      else if (saleUnit === 'strip') unitPrice = Number(medicine.sale_price_strip || medicine.sale_price_unit * medicine.units_per_strip);
      else unitPrice = Number(medicine.sale_price_box || medicine.sale_price_unit * medicine.units_per_strip * medicine.strips_per_box);

      const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
      subtotal += lineTotal;

      if (medicine.requires_prescription) requiresPrescriptionWarning = true;

      // الـ triggers هتتولى: تحويل الكمية للحبة، خصم FEFO من التشغيلات الصالحة بس، حساب التكلفة،
      // وتسجيل التشغيلة المخصوم منها، ورفض البيع لو الكمية الصالحة غير كافية
      await client.query(
        `INSERT INTO sale_items (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, unit_price, total, unit_label)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7, $8)`,
        [invoiceId, medicine.id, medicine.name, saleUnit, quantity, unitPrice, lineTotal, unitLabel]
      );
    }

    // الخصم النهائي (يدوي + كوبون) — الإجمالي بيتحسب في قاعدة البيانات من البنود ويتسجل في الخزنة
    let couponAmount = 0;
    if (appliedCoupon) {
      couponAmount = appliedCoupon.discount_percent
        ? (subtotal * Number(appliedCoupon.discount_percent)) / 100
        : Number(appliedCoupon.discount_amount || 0);
    }
    const totalDiscount = Math.min(manualDiscount + couponAmount, subtotal);

    const finalized = await client.query('SELECT finalize_sale_invoice($1, $2, $3) AS total', [invoiceId, totalDiscount, userId]);
    const invoiceTotal = Number(finalized.rows[0].total);

    await client.query('COMMIT');
    began = false;

    await logActivity(req, {
      action: 'إتمام عملية بيع',
      entityType: 'sale_invoice',
      entityId: invoiceId,
      details: { total: invoiceTotal, customer_name: customer_name || null }
    });

    res.json({ ok: true, invoiceId, requiresPrescriptionWarning });
  } catch (err) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch (e) { /* الاتصال اتقفل */ }
    }
    // طلب مكرر بنفس المفتاح وصل في نفس اللحظة: الفاتورة الأولى هي اللي اتسجلت
    if (err && err.code === '23505' && idemKey) {
      try {
        const dup = await client.query('SELECT id FROM sale_invoices WHERE idempotency_key = $1 AND created_by = $2', [idemKey, userId]);
        if (dup.rows[0]) return res.json({ ok: true, invoiceId: dup.rows[0].id, duplicate: true });
      } catch (e) { /* نكمل للرد بالخطأ */ }
    }
    if (!isBusinessError(err)) console.error('❌ فشل إتمام عملية البيع:', err);
    res.status(statusFor(err) === 500 ? 400 : statusFor(err)).json({ error: userMessage(err, 'فشل إتمام عملية البيع') });
  } finally {
    client.release();
  }
});

// صفحة الفاتورة القابلة للطباعة
router.get('/receipt/:invoiceId', async (req, res, next) => {
  try {
    const invoice = await queryOne('SELECT * FROM sale_invoices WHERE id = $1', [req.params.invoiceId]);
    if (!invoice) return res.status(404).send('الفاتورة غير موجودة');

    const items = await query('SELECT * FROM sale_items WHERE invoice_id = $1 ORDER BY id', [invoice.id]);
    const pharmacyName = await queryOne(`SELECT value FROM settings WHERE key = 'pharmacy_name'`);
    const pharmacyPhone = await queryOne(`SELECT value FROM settings WHERE key = 'pharmacy_phone'`);
    const pharmacyAddress = await queryOne(`SELECT value FROM settings WHERE key = 'pharmacy_address'`);

    res.render('receipt', {
      invoice,
      items,
      shopSettings: {
        name: pharmacyName ? pharmacyName.value : 'الصيدلية',
        phone: pharmacyPhone ? pharmacyPhone.value : null,
        address: pharmacyAddress ? pharmacyAddress.value : null
      }
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
