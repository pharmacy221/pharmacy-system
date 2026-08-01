// routes/pos.js
// شاشة الكاشير: بحث عن صنف بالاسم/الباركود، اختيار وحدة البيع (حبة / شريط / علبة)
// مع اقتراح ذكي "ينفع تاخد شريط بدل الحبايد" (upsell) وقفل بيع عند نقص المخزون.
const express = require('express');
const { query, queryOne, getClient } = require('../db');
const { requireLogin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

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

// البحث عن صنف بالاسم أو الباركود أو الاسم العلمي (نتيجة فورية لشاشة الكاشير)
router.get('/search', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ results: [] });

    const results = await query(
      `SELECT * FROM medicines
       WHERE is_active = true AND (name ILIKE $1 OR generic_name ILIKE $1 OR barcode = $2)
       ORDER BY lower(name) LIMIT 10`,
      [`%${q}%`, q]
    );
    res.json({ results });
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

    res.json({ found: true, medicine });
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

// تسجيل عملية بيع وخصم المخزون (FEFO) - الشغل التفصيلي بيتم جوه الـ DB triggers
router.post('/checkout', async (req, res, next) => {
  const { items, customer_name, customer_phone, payment_method, discount_amount, coupon_code, notes } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'السلة فارغة' });
  }

  const userId = req.session.userId;
  const client = await getClient();

  try {
    await client.query('BEGIN');

    // لازم وردية مفتوحة قبل أي عملية بيع
    const activeShiftResult = await client.query(
      'SELECT id FROM shifts WHERE opened_by = $1 AND closed_at IS NULL',
      [userId]
    );
    if (activeShiftResult.rows.length === 0) {
      throw new Error('يجب فتح وردية أولاً قبل إجراء عملية البيع');
    }

    // خصم الكوبون (لو موجود)
    let couponDiscount = 0;
    let appliedCoupon = null;
    if (coupon_code && coupon_code.trim()) {
      const code = coupon_code.trim().toUpperCase();
      const couponResult = await client.query('SELECT * FROM coupons WHERE code = $1 FOR UPDATE', [code]);
      const coupon = couponResult.rows[0];
      if (!coupon) throw new Error('الكوبون غير موجود');
      if (!coupon.active) throw new Error('الكوبون متوقف');
      if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) throw new Error('الكوبون منتهي الصلاحية');
      appliedCoupon = coupon;
    }

    const manualDiscount = parseFloat(discount_amount) || 0;

    // احتياج للتحقق من وجود روشتة لأي صنف يستلزمها (تنبيه فقط، مش قفل صارم)
    let requiresPrescriptionWarning = false;

    // إنشاء رأس الفاتورة (discount مبدئي، الـ total هيتحدث تلقائياً بعد إدخال البنود)
    const invoiceResult = await client.query(
      `INSERT INTO sale_invoices (customer_name, customer_phone, discount, payment_method, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        customer_name && customer_name.trim() ? customer_name.trim() : null,
        customer_phone && customer_phone.trim() ? customer_phone.trim() : null,
        0, // بنحدث الخصم النهائي بعد ما نعرف الإجمالي الفرعي
        ['cash', 'card', 'other'].includes(payment_method) ? payment_method : 'cash',
        notes || null,
        userId
      ]
    );
    const invoiceId = invoiceResult.rows[0].id;

    let subtotal = 0;
    const soldSummary = [];

    for (const item of items) {
      const medResult = await client.query('SELECT * FROM medicines WHERE id = $1 FOR UPDATE', [item.medicine_id]);
      const medicine = medResult.rows[0];
      if (!medicine) throw new Error(`الصنف رقم ${item.medicine_id} غير موجود`);

      const saleUnit = ['unit', 'strip', 'box'].includes(item.sale_unit) ? item.sale_unit : 'unit';
      const quantity = parseInt(item.quantity) || 1;

      let unitPrice;
      if (saleUnit === 'unit') unitPrice = Number(medicine.sale_price_unit);
      else if (saleUnit === 'strip') unitPrice = Number(medicine.sale_price_strip || medicine.sale_price_unit * medicine.units_per_strip);
      else unitPrice = Number(medicine.sale_price_box || medicine.sale_price_unit * medicine.units_per_strip * medicine.strips_per_box);

      const lineTotal = Math.round(unitPrice * quantity * 100) / 100;
      subtotal += lineTotal;

      if (medicine.requires_prescription) requiresPrescriptionWarning = true;

      // الـ triggers هتتولى: تحويل الكمية للحبة، خصم المخزون بنظام FEFO، حساب متوسط التكلفة، ورفض البيع لو المخزون غير كافي
      await client.query(
        `INSERT INTO sale_items (invoice_id, medicine_id, medicine_name_snapshot, sale_unit, quantity, quantity_units, unit_price, total)
         VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
        [invoiceId, medicine.id, medicine.name, saleUnit, quantity, unitPrice, lineTotal]
      );

      soldSummary.push({ name: medicine.name, sale_unit: saleUnit, quantity });
    }

    // حساب الخصم النهائي (يدوي + كوبون) وتحديثه على الفاتورة (الـ trigger بيعيد حساب total = مجموع البنود - discount)
    let couponAmount = 0;
    if (appliedCoupon) {
      couponAmount = appliedCoupon.discount_percent
        ? (subtotal * Number(appliedCoupon.discount_percent)) / 100
        : Number(appliedCoupon.discount_amount || 0);
    }
    const totalDiscount = Math.min(manualDiscount + couponAmount, subtotal);

    await client.query(
      `UPDATE sale_invoices SET discount = $1, total = $2 WHERE id = $3`,
      [totalDiscount, Math.max(0, subtotal - totalDiscount), invoiceId]
    );

    await client.query('COMMIT');

    await logActivity(req, {
      action: 'إتمام عملية بيع',
      entityType: 'sale_invoice',
      entityId: invoiceId,
      details: { total: Math.max(0, subtotal - totalDiscount), customer_name: customer_name || null }
    });

    res.json({ ok: true, invoiceId, requiresPrescriptionWarning });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message || 'فشل إتمام عملية البيع' });
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
