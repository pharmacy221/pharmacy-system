const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin, requireAdmin);

// خريطة اسم الحقل (إنجليزي) -> لابل عرض بالعربي
const FIELD_LABELS = {
  username: 'المستخدم',
  entity_type: 'نوع العملية',
  entity_id: 'رقم العنصر',

  medicine_name: 'اسم الصنف',
  medicine_id: 'رقم الصنف',
  invoice_id: 'رقم الفاتورة',
  batch_number: 'رقم التشغيلة',
  expiry_date: 'تاريخ الصلاحية',
  supplier_name: 'المورد',
  customer_name: 'اسم العميل',
  customer_phone: 'رقم الهاتف',
  sale_unit: 'وحدة البيع',

  total: 'الإجمالي',
  quantity: 'الكمية',
  price: 'السعر',
  cost_price: 'سعر التكلفة',
  reason: 'السبب',
  notes: 'ملاحظات',

  old_value: 'القيمة القديمة',
  new_value: 'القيمة الجديدة',
  status: 'الحالة',

  // مرتجعات / إلغاء فواتير
  refund_amount: 'المبلغ المسترد',
  refund_due: 'المبلغ المستحق رده',
  refund_method: 'طريقة الرد',
  restored_units: 'الوحدات المرجّعة للمخزون',
  restocked_units: 'الوحدات المرجّعة للمخزون',
  expired_units_not_restocked: 'وحدات منتهية لم تُرجَع للمخزون',
  unbatched_units_not_restocked: 'وحدات بدون تشغيلة صالحة لم تُرجَع',

  // تسوية المخزون / الأرصدة الافتتاحية
  difference: 'الفرق',
  opening_units: 'الرصيد الافتتاحي (وحدات)',
  opening_expiry: 'صلاحية الرصيد الافتتاحي',
  cost_price_unit: 'تكلفة الوحدة',

  // الورديات
  expected_cash: 'النقدية المتوقعة',
  actual_cash: 'النقدية الفعلية'
};

const LTR_FIELDS = new Set(['customer_phone', 'entity_id', 'batch_number']);

function formatDetails(details) {
  if (!details) return { username: null, list: [] };

  let obj = details;
  if (typeof details === 'string') {
    try {
      obj = JSON.parse(details);
    } catch (err) {
      return { username: null, list: [{ label: 'تفاصيل', value: details, ltr: false }] };
    }
  }

  if (typeof obj !== 'object' || obj === null) {
    return { username: null, list: [{ label: 'تفاصيل', value: String(obj), ltr: false }] };
  }

  const { username, entity_type: entityType, entity_id: entityId, ...rest } = obj;

  const list = Object.entries(rest)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => {
      let displayValue = value;
      if (typeof value === 'number') {
        displayValue = value.toLocaleString('ar-EG');
      }
      return {
        label: FIELD_LABELS[key] || key,
        value: displayValue,
        ltr: LTR_FIELDS.has(key) || typeof value === 'number'
      };
    });

  return { username: username || null, entityType: entityType || null, entityId: entityId || null, list };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await query(
      'SELECT * FROM activity_log ORDER BY created_at DESC LIMIT 300'
    );
    const rowsWithDetails = rows.map((r) => {
      const { username, entityType, entityId, list } = formatDetails(r.details);
      return { ...r, username, entity_type: entityType, entity_id: entityId, detailsFormatted: list };
    });
    res.render('activity-log', { rows: rowsWithDetails, active: 'activity-log' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
