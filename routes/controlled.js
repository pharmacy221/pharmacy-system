// routes/controlled.js
// سجل صرف الأدوية الخاضعة للرقابة (مخدرات / منظّمة): مين اتصرف له إيه وبأنهي روشتة.
// البيانات بتتسجّل أوتوماتيك من شاشة الكاشير ومبتتعدّلش ولا بتتحذف. هنا عرض + تصدير + طباعة.
const express = require('express');
const { query } = require('../db');
const { requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireRole('admin', 'pharmacist'));

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function csvCell(v) {
  let s = v == null ? '' : String(v);
  // حماية من حقن معادلات الإكسيل (=,+,-,@) في الملف المصدّر
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

router.get('/', async (req, res, next) => {
  try {
    const today = (await query(`SELECT to_char(pharmacy_today(), 'YYYY-MM-DD') AS d, to_char(date_trunc('month', pharmacy_today()), 'YYYY-MM-DD') AS m`))[0];
    const from = ISO.test(req.query.from || '') ? req.query.from : today.m;
    const to = ISO.test(req.query.to || '') ? req.query.to : today.d;
    const medicineId = parseInt(req.query.medicine_id, 10) || null;
    const q = (req.query.q || '').trim();

    const params = [from, to];
    let where = `pharmacy_date(cd.created_at) BETWEEN $1::date AND $2::date`;
    if (medicineId) { params.push(medicineId); where += ` AND cd.medicine_id = $${params.length}`; }
    if (q) {
      params.push(`%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
      where += ` AND (cd.patient_name ILIKE $${params.length} OR cd.national_id ILIKE $${params.length} OR cd.prescription_no ILIKE $${params.length})`;
    }

    const rows = await query(
      `SELECT cd.*, i.status AS invoice_status, u.username AS dispenser
       FROM controlled_dispensing cd
       JOIN sale_invoices i ON i.id = cd.invoice_id
       LEFT JOIN users u ON u.id = cd.dispensed_by
       WHERE ${where}
       ORDER BY cd.created_at DESC, cd.id DESC
       LIMIT 2000`,
      params
    );

    if (req.query.format === 'csv') {
      const head = ['التاريخ', 'رقم الفاتورة', 'الصنف', 'الكمية', 'الوحدة', 'اسم المريض', 'الرقم القومي/الجواز', 'رقم الروشتة', 'الطبيب', 'الصارف', 'حالة الفاتورة'];
      const lines = [head.map(csvCell).join(',')].concat(rows.map((r) => [
        new Date(r.created_at).toISOString(), r.invoice_id, r.medicine_name, r.quantity, r.unit_label || '',
        r.patient_name, r.national_id, r.prescription_no, r.doctor_name || '', r.dispenser || '',
        r.invoice_status === 'voided' ? 'ملغاة' : 'مكتملة'
      ].map(csvCell).join(',')));
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="controlled-${from}_${to}.csv"` });
      return res.send('﻿' + lines.join('\r\n'));
    }

    // ملخص لكل صنف خاضع للرقابة: المصروف في الفترة (الفواتير المكتملة فقط) + الرصيد الحالي
    const summary = await query(
      `SELECT m.id, m.name, m.stock_units,
              COALESCE(SUM(cd.quantity_units) FILTER (WHERE i.status = 'completed' AND pharmacy_date(cd.created_at) BETWEEN $1::date AND $2::date), 0)::int AS dispensed_units,
              COUNT(cd.id) FILTER (WHERE i.status = 'completed' AND pharmacy_date(cd.created_at) BETWEEN $1::date AND $2::date)::int AS dispensings
       FROM medicines m
       LEFT JOIN controlled_dispensing cd ON cd.medicine_id = m.id
       LEFT JOIN sale_invoices i ON i.id = cd.invoice_id
       WHERE m.controlled_substance = true AND m.is_active = true
       GROUP BY m.id ORDER BY m.name`,
      [from, to]
    );

    res.render('controlled', { rows, summary, from, to, medicineId, q, active: 'controlled' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
