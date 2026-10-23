// routes/products.js
// إدارة الأصناف (الأدوية/المستحضرات) + التشغيلات (batches) والصلاحية
const express = require('express');
const { query, queryOne, getClient } = require('../db');
const { requireLogin, requireAdmin, requireRole } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');
const { FORMS, FORM_ORDER, saleLevels } = require('../lib/drug-form');
const { BusinessError, isBusinessError, statusFor, userMessage } = require('../lib/errors');

const router = express.Router();
router.use(requireLogin);

const PAGE_SIZE = 60;
// متغيرات مشتركة لكل صفحات الأصناف (الترقيم + الفلاتر + نوع المنتج + اسم الوحدة)
router.use((req, res, next) => {
  res.locals.pg = { page: 1, pages: 1, total: null, form: '', instock: false };
  res.locals.formKinds = Object.entries(FORMS).map(([key, f]) => ({ key, label: f.label }));
  res.locals.unitName = (p) => saleLevels(p).levels[0].label;
  // اسم القسم/النوع اللي بيظهر جنب الصنف (حبوب / فوار / حقن ...)
  res.locals.formLabel = (p) => (p.form_kind && FORMS[p.form_kind] ? FORMS[p.form_kind].label : 'غير مصنّف');
  res.locals.groups = [];
  // بيقسّم المخزون الحالي (بالوحدة الصغرى) لـ علب / شرائط / وحدات سايبة حسب نوع الصنف
  res.locals.stockSplit = (p) => {
    const f = p.form_kind ? FORMS[p.form_kind] : null;
    const ups = Math.max(parseInt(p.units_per_strip) || 1, 1);
    const spb = Math.max(parseInt(p.strips_per_box) || 1, 1);
    let t = Math.max(parseInt(p.stock_units) || 0, 0);
    if (f && !f.counted) return { box: 0, strip: 0, unit: t };
    const hasStrip = !f || f.strip;
    const perBox = hasStrip ? ups * spb : ups;
    let box = 0, strip = 0;
    if (perBox > 1) { box = Math.floor(t / perBox); t -= box * perBox; }
    if (hasStrip && spb > 1 && ups > 1) { strip = Math.floor(t / ups); t -= strip * ups; }
    return { box, strip, unit: t };
  };
  // بيانات أنواع المنتجات للجافاسكربت: بتحدد الحقول اللي تظهر في فورم الإضافة/التعديل
  res.locals.formMeta = Object.fromEntries(Object.entries(FORMS).map(([k, f]) => [k, { unit: f.unit, counted: !!f.counted, strip: !!f.strip }]));
  next();
});

const CATEGORIES = ['أدوية', 'مستحضرات تجميل', 'مكملات غذائية', 'أدوات طبية', 'رضاعة وأطفال', 'أخرى'];

// ترتيب الأقسام: حبوب ← فوار ← كبسول ← حقن ... (الأصناف بدون نوع في الآخر)
const GROUP_ORDER_SQL = `COALESCE(array_position(ARRAY[${FORM_ORDER.map((k) => `'${k}'`).join(',')}]::text[], form_kind), 999)`;

// توحيد الحروف العربية (أ إ آ ← ا ، ة ← ه ، ى ← ي) عشان البحث ميتأثرش بالكتابة
const normText = (s) => String(s || '').toLowerCase()
  .replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[\u064B-\u0652\u0640]/g, '');
const SQL_NORM = (expr) => `translate(lower(${expr}), 'أإآةى', 'اااهي')`;
// كل بيانات الصنف القابلة للبحث في نص واحد
const HAYSTACK = SQL_NORM(`concat_ws(' ', name, generic_name, barcode, serial_number, conditions_tags, manufacturer)`);
const escLike = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

// البحث: كل كلمة لازم تتلاقي في أي مكان (اسم / علمي / باركود / سريال / حالة / شركة) بأي ترتيب
function buildWhere({ q, form, instock }) {
  const params = [];
  const where = ['is_active = true'];
  const tokens = normText(q).split(/\s+/).filter(Boolean).slice(0, 8);
  tokens.forEach((t) => { params.push(`%${escLike(t)}%`); where.push(`${HAYSTACK} LIKE $${params.length}`); });
  if (form === 'none') where.push('form_kind IS NULL');
  else if (form && FORMS[form]) { params.push(form); where.push(`form_kind = $${params.length}`); }
  if (instock) where.push('stock_units > 0');
  return { w: where.join(' AND '), params, tokens };
}

// عدد الأصناف في كل قسم (بيحترم البحث و"المتاح فقط" بس مش فلتر القسم نفسه)
async function getGroupCounts({ q, instock }) {
  const { w, params } = buildWhere({ q, instock });
  const rows = await query(`SELECT form_kind, COUNT(*)::int AS c FROM medicines WHERE ${w} GROUP BY form_kind`, params);
  const byKind = new Map(rows.map((r) => [r.form_kind, r.c]));
  const groups = FORM_ORDER.filter((k) => byKind.get(k)).map((k) => ({ key: k, label: FORMS[k].label, count: byKind.get(k) }));
  if (byKind.get(null)) groups.push({ key: 'none', label: 'غير مصنّف', count: byKind.get(null) });
  return groups;
}

// بحث + فلتر القسم + المتاح فقط + ترقيم (الدليل فيه آلاف الأصناف)
// وقت البحث: النتائج مترتبة بالأقرب أولاً (باركود/سريال مطابق ← الاسم يبدأ بالكلمة ← باقي النتائج)
async function getMedicinesPage({ q, form, instock, page }) {
  const { w, params, tokens } = buildWhere({ q, form, instock });
  const total = (await queryOne(`SELECT COUNT(*)::int AS c FROM medicines WHERE ${w}`, params)).c;
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const p = Math.min(Math.max(parseInt(page) || 1, 1), pages);

  let orderBy = `${GROUP_ORDER_SQL}, lower(name)`;
  const rowParams = params.slice();
  if (tokens.length) {
    rowParams.push(String(q).trim());
    const iRaw = rowParams.length;
    rowParams.push(`${escLike(normText(q).trim())}%`);
    const iFull = rowParams.length;
    rowParams.push(`${escLike(tokens[0])}%`);
    const iFirst = rowParams.length;
    const nameN = SQL_NORM('name');
    const rank = `CASE WHEN barcode = $${iRaw} OR serial_number = $${iRaw} THEN 0
      WHEN ${nameN} LIKE $${iFull} THEN 1
      WHEN ${nameN} LIKE $${iFirst} THEN 2
      ELSE 3 END`;
    orderBy = `${rank}, ${GROUP_ORDER_SQL}, lower(name)`;
  }
  const rows = await query(
    `SELECT * FROM medicines WHERE ${w} ORDER BY ${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${(p - 1) * PAGE_SIZE}`,
    rowParams
  );
  return { rows, total, pages, page: p };
}

// نسخة مختصرة للصفحات اللي بترجع بخطأ (أول صفحة بس)
async function getMedicines(q) {
  return (await getMedicinesPage({ q, page: 1 })).rows;
}

// يحوّل قيمة سن (نص) لرقم أو null لو فاضية
function parseAge(val) {
  if (val === undefined || val === null || val === '') return null;
  const n = parseFloat(val);
  return Number.isNaN(n) ? null : n;
}

// بيظبط حقول التعبئة والأسعار حسب نوع المنتج:
//  - زجاجة/كريم/شراب/بخاخ...: وحدة واحدة بس، من غير حبات/شرايط وأسعارها
//  - حقن/لبوس/أكياس/فوار: وحدات بالعلبة بس (من غير شرايط)
//  - حبوب/كبسول: حبة / شريط / علبة (كله اختياري)
function packFields(kind, b) {
  const f = kind ? FORMS[kind] : null;
  let ups = parseInt(b.units_per_strip) || 1;
  let spb = parseInt(b.strips_per_box) || 1;
  let strip = b.sale_price_strip ? parseFloat(b.sale_price_strip) : null;
  let box = b.sale_price_box ? parseFloat(b.sale_price_box) : null;
  if (f && !f.counted) { ups = 1; spb = 1; strip = null; box = null; }
  else if (f && !f.strip) { spb = 1; strip = null; }
  return { ups, spb, strip, box };
}

// إجمالي المخزون بالوحدة الصغرى من (علب + شرائط + وحدات سايبة)
function stockTotal(pack, b) {
  const n = (v) => Math.max(parseInt(v) || 0, 0);
  return n(b.stock_box_qty) * pack.ups * pack.spb + n(b.stock_strip_qty) * pack.ups + n(b.stock_unit_qty);
}

// يشغّل مجموعة عمليات في transaction واحدة (أو يتراجع عنها كلها لو أي واحدة فشلت)
async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (e) { /* الاتصال اتقفل */ }
    throw err;
  } finally {
    client.release();
  }
}

// تاريخ بصيغة YYYY-MM-DD وفعلي (مش 2026-02-31)، وإلا null
function parseDateStrict(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.trim())) return null;
  const s = v.trim();
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s;
}

// ============ قائمة الأصناف ============
router.get('/', async (req, res, next) => {
  try {
    const form = req.query.form || '';
    const instock = req.query.instock === '1';
    const [r, groups] = await Promise.all([
      getMedicinesPage({ q: req.query.q, form, instock, page: req.query.page }),
      getGroupCounts({ q: req.query.q, instock })
    ]);
    res.locals.groups = groups;
    res.locals.pg = { page: r.page, pages: r.pages, total: r.total, form, instock };
    res.render('products', { medicines: r.rows, categories: CATEGORIES, error: null, searchQuery: req.query.q || '', active: 'products' });
  } catch (err) {
    next(err);
  }
});

// ============ إضافة صنف جديد ============
router.post('/add', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, generic_name, category, dosage_form, manufacturer, barcode, serial_number,
      requires_prescription, controlled_substance,
      units_per_strip, strips_per_box,
      sale_price_unit, sale_price_strip, sale_price_box,
      cost_price_unit, min_stock_units,
      conditions_tags, min_age_years, max_age_years, form_kind
    } = req.body;
    const kind = FORMS[form_kind] ? form_kind : null;
    const pack = packFields(kind, req.body);

    if (!name || !name.trim() || sale_price_unit === undefined || sale_price_unit === '') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'اسم الصنف وسعر البيع مطلوبين', searchQuery: '', active: 'products' });
    }

    // رصيد افتتاحي: لازم يتسجل كتشغيلة بتاريخ صلاحية (المخزون مصدره التشغيلات بس)
    const openingUnits = stockTotal(pack, req.body);
    const openingExpiry = parseDateStrict(req.body.opening_expiry);
    const costUnit = Math.max(parseFloat(cost_price_unit) || 0, 0);
    if (openingUnits > 0 && !openingExpiry) {
      throw new BusinessError('الرصيد الافتتاحي لازم يكون معاه تاريخ صلاحية صحيح');
    }

    const medicineId = await withTransaction(async (c) => {
      if (openingUnits > 0) {
        const t = await c.query(`SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS today`);
        if (openingExpiry < t.rows[0].today) throw new BusinessError('تاريخ صلاحية الرصيد الافتتاحي منتهي؛ مينفعش تسجله كمخزون صالح');
      }
      // المخزون بيبدأ بصفر والتشغيلة هي اللي بتزوّده (trigger المزامنة)
      const ins = await c.query(
        `INSERT INTO medicines (
            name, generic_name, category, dosage_form, manufacturer, barcode, serial_number,
            requires_prescription, controlled_substance,
            units_per_strip, strips_per_box,
            sale_price_unit, sale_price_strip, sale_price_box,
            cost_price_unit, stock_units, min_stock_units,
            conditions_tags, min_age_years, max_age_years, form_kind
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,0,$16,$17,$18,$19,$20)
         RETURNING id`,
        [
          name.trim(),
          generic_name && generic_name.trim() ? generic_name.trim() : null,
          (category || 'أدوية').trim(),
          dosage_form && dosage_form.trim() ? dosage_form.trim() : null,
          manufacturer && manufacturer.trim() ? manufacturer.trim() : null,
          barcode && barcode.trim() ? barcode.trim() : null,
          serial_number && serial_number.trim() ? serial_number.trim() : null,
          requires_prescription === 'on',
          controlled_substance === 'on',
          pack.ups,
          pack.spb,
          parseFloat(sale_price_unit) || 0,
          pack.strip,
          pack.box,
          costUnit,
          parseInt(min_stock_units) || 10,
          conditions_tags && conditions_tags.trim() ? conditions_tags.trim() : null,
          parseAge(min_age_years),
          parseAge(max_age_years),
          kind
        ]
      );
      const id = ins.rows[0].id;
      if (openingUnits > 0) {
        await c.query(
          `INSERT INTO batches (medicine_id, batch_number, expiry_date, received_units, quantity_units, cost_price_unit)
           VALUES ($1, 'OPENING', $2, $3, $3, $4)`,
          [id, openingExpiry, openingUnits, costUnit]
        );
      }
      return id;
    });

    await logActivity(req, {
      action: 'إضافة صنف جديد', entityType: 'medicine', entityId: medicineId,
      details: { medicine_name: name.trim(), opening_units: openingUnits, opening_expiry: openingUnits > 0 ? openingExpiry : null }
    });
    res.redirect('/products');
  } catch (err) {
    if (err.code === '23505') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'الباركود أو السريال ده مستخدم في صنف تاني بالفعل', searchQuery: '', active: 'products' });
    }
    if (isBusinessError(err)) {
      const medicines = await getMedicines();
      return res.status(statusFor(err)).render('products', { medicines, categories: CATEGORIES, error: userMessage(err), searchQuery: '', active: 'products' });
    }
    next(err);
  }
});

// ============ تعديل صنف ============
router.post('/:id/update', requireAdmin, async (req, res, next) => {
  try {
    const {
      name, generic_name, category, dosage_form, manufacturer, barcode, serial_number,
      requires_prescription, controlled_substance,
      units_per_strip, strips_per_box,
      sale_price_unit, sale_price_strip, sale_price_box,
      cost_price_unit, min_stock_units,
      conditions_tags, min_age_years, max_age_years, form_kind
    } = req.body;
    const kind = FORMS[form_kind] ? form_kind : null;
    // لو النوع مااتغيرش (— بدون تغيير —) نعتمد على النوع المحفوظ للصنف
    const current = await queryOne('SELECT form_kind, stock_units FROM medicines WHERE id = $1', [req.params.id]);
    const pack = packFields(kind || (current && current.form_kind) || null, req.body);

    await withTransaction(async (c) => {
      // سجل تغيّر الأسعار (migration_006): بنعرّفه مين غيّر السعر والمصدر يدوي
      await c.query(`SELECT set_config('app.price_source', 'manual', true), set_config('app.user_id', $1, true)`, [String(req.session.userId)]);
      await c.query(
        `UPDATE medicines SET
            name = $1, generic_name = $2, category = $3, dosage_form = $4, manufacturer = $5, barcode = $6, serial_number = $7,
            requires_prescription = $8, controlled_substance = $9,
            units_per_strip = $10, strips_per_box = $11,
            sale_price_unit = $12, sale_price_strip = $13, sale_price_box = $14,
            cost_price_unit = $15, min_stock_units = $16,
            conditions_tags = $17, min_age_years = $18, max_age_years = $19, form_kind = COALESCE($20, form_kind)
         WHERE id = $21`,
        [
          name.trim(),
          generic_name && generic_name.trim() ? generic_name.trim() : null,
          (category || 'أدوية').trim(),
          dosage_form && dosage_form.trim() ? dosage_form.trim() : null,
          manufacturer && manufacturer.trim() ? manufacturer.trim() : null,
          barcode && barcode.trim() ? barcode.trim() : null,
          serial_number && serial_number.trim() ? serial_number.trim() : null,
          requires_prescription === 'on',
          controlled_substance === 'on',
          pack.ups,
          pack.spb,
          parseFloat(sale_price_unit) || 0,
          pack.strip,
          pack.box,
          parseFloat(cost_price_unit) || 0,
          parseInt(min_stock_units) || 10,
          conditions_tags && conditions_tags.trim() ? conditions_tags.trim() : null,
          parseAge(min_age_years),
          parseAge(max_age_years),
          kind,
          req.params.id
        ]
      );

      // المخزون بيتغير بس لو المستخدم عدّل خانات الكمية (عشان مانكتبش فوق مبيعات حصلت في نفس الوقت).
      // التغيير بيتم كتسوية مسجلة على التشغيلات (قبل/بعد/الفرق/السبب/المستخدم) في نفس الـ transaction.
      if (req.body.stock_dirty === '1') {
        await c.query('SELECT adjust_medicine_stock($1, $2, $3, $4, $5)', [
          req.params.id,
          stockTotal(pack, req.body),
          'تعديل من شاشة الأصناف',
          req.session.userId,
          req.session.username || null
        ]);
      }
    });

    await logActivity(req, { action: 'تعديل بيانات صنف', entityType: 'medicine', entityId: req.params.id });
    res.redirect('/products');
  } catch (err) {
    if (err.code === '23505') {
      const medicines = await getMedicines();
      return res.render('products', { medicines, categories: CATEGORIES, error: 'الباركود أو السريال ده مستخدم في صنف تاني بالفعل', searchQuery: '', active: 'products' });
    }
    if (isBusinessError(err)) {
      const medicines = await getMedicines();
      return res.status(statusFor(err)).render('products', { medicines, categories: CATEGORIES, error: userMessage(err), searchQuery: '', active: 'products' });
    }
    next(err);
  }
});

// ============ إلغاء تفعيل صنف (بدل الحذف النهائي عشان تاريخ المبيعات القديم يفضل سليم) ============
router.post('/:id/delete', requireAdmin, async (req, res, next) => {
  try {
    await query('UPDATE medicines SET is_active = false WHERE id = $1', [req.params.id]);
    await logActivity(req, { action: 'إلغاء تفعيل صنف', entityType: 'medicine', entityId: req.params.id });
    res.redirect('/products');
  } catch (err) {
    next(err);
  }
});

// ============ التشغيلات (Batches) + تنبيهات الصلاحية ============
router.get('/batches', async (req, res, next) => {
  try {
    const medicines = await query('SELECT id, name, units_per_strip, strips_per_box FROM medicines WHERE is_active = true ORDER BY lower(name)');
    const suppliers = await query('SELECT id, name FROM suppliers ORDER BY lower(name)');

    const batches = await query(`
      SELECT b.*, m.name AS medicine_name, s.name AS supplier_name,
             (b.expiry_date - pharmacy_today()) AS days_left
      FROM batches b
      JOIN medicines m ON m.id = b.medicine_id
      LEFT JOIN suppliers s ON s.id = b.supplier_id
      WHERE b.quantity_units > 0
      ORDER BY b.expiry_date ASC
    `);

    res.render('batches', { medicines, suppliers, batches, active: 'batches', error: null });
  } catch (err) {
    next(err);
  }
});

// إضافة تشغيلة جديدة (استلام بضاعة) - المخزون والتكلفة بيتحدّثوا أوتوماتيك بالـ trigger
// صلاحية: أدمن / صيدلي فقط. والتحقق من البيانات هنا قبل الوصول لقاعدة البيانات.
router.post('/batches/add', requireRole('admin', 'pharmacist'), async (req, res, next) => {
  try {
    const { medicine_id, supplier_id, batch_number, expiry_date, received_units, cost_price_unit } = req.body;

    const medId = parseInt(medicine_id, 10);
    const qty = Number(received_units);
    const cost = Number(cost_price_unit);
    const expiry = parseDateStrict(expiry_date);
    const supId = supplier_id ? parseInt(supplier_id, 10) : null;

    if (!Number.isInteger(medId) || medId <= 0 || !expiry || received_units === undefined || received_units === '' || cost_price_unit === undefined || cost_price_unit === '') {
      throw new BusinessError('كل الحقول (الصنف، تاريخ الصلاحية، الكمية، سعر التكلفة) مطلوبة وبصيغة صحيحة');
    }
    if (!Number.isInteger(qty) || qty <= 0) throw new BusinessError('الكمية لازم تكون رقم صحيح أكبر من صفر');
    if (qty > 10000000) throw new BusinessError('الكمية كبيرة جدًا');
    if (!Number.isFinite(cost) || cost < 0) throw new BusinessError('سعر التكلفة لازم يكون صفر أو أكتر');
    if (supplier_id && (!Number.isInteger(supId) || supId <= 0)) throw new BusinessError('المورد غير صحيح');

    const today = (await queryOne(`SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS today`)).today;
    if (expiry < today) throw new BusinessError('تاريخ الصلاحية منتهي؛ مينفعش تستلم تشغيلة منتهية كمخزون صالح');

    const med = await queryOne('SELECT id FROM medicines WHERE id = $1 AND is_active = true', [medId]);
    if (!med) throw new BusinessError('الصنف غير موجود أو غير مفعّل', 404);

    await query(
      `INSERT INTO batches (medicine_id, supplier_id, batch_number, expiry_date, received_units, quantity_units, cost_price_unit)
       VALUES ($1, $2, $3, $4, $5, $5, $6)`,
      [medId, supId, batch_number && batch_number.trim() ? batch_number.trim() : null, expiry, qty, cost]
    );

    await logActivity(req, {
      action: 'استلام تشغيلة جديدة',
      entityType: 'batch',
      details: { medicine_id: medId, quantity: qty, expiry_date: expiry, cost_price_unit: cost }
    });
    res.redirect('/products/batches');
  } catch (err) {
    if (err && err.code === '23503') return res.status(400).send('المورد أو الصنف غير موجود');
    if (isBusinessError(err)) return res.status(statusFor(err)).send(userMessage(err));
    next(err);
  }
});

module.exports = router;
