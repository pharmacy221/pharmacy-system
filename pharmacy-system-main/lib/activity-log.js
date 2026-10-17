const { query } = require('../db');

/**
 * تسجيل حدث حساس في سجل النشاطات (activity_log).
 * لا تُفشل الطلب الأصلي أبدًا لو التسجيل فشل - بنطبع الخطأ في الـ console بس.
 *
 * @param {import('express').Request} req - الطلب الحالي (بنجيب منه المستخدم من الجلسة)
 * @param {Object} options
 * @param {string} options.action - وصف الحدث بالعربي، مثال: "حذف صنف"
 * @param {string} [options.entityType] - نوع الكيان المتأثر
 * @param {string|number} [options.entityId] - معرف الكيان المتأثر
 * @param {Object} [options.details] - أي بيانات إضافية (قبل/بعد التعديل، ملاحظة...)
 */
async function logActivity(req, { action, entityType = null, entityId = null, details = null }) {
  try {
    const userId = req.session ? req.session.userId : null;
    const username = req.session ? req.session.username : null;

    const payload = {
      username: username || null,
      entity_type: entityType,
      entity_id: entityId !== null && entityId !== undefined ? String(entityId) : null,
      ...(details || {})
    };

    await query(
      `INSERT INTO activity_log (user_id, action, details) VALUES ($1, $2, $3)`,
      [userId, action, JSON.stringify(payload)]
    );
  } catch (err) {
    // مهم: فشل تسجيل اللوج لازم ميكسرش العملية الأساسية للمستخدم
    console.error('⚠️ فشل تسجيل النشاط في activity_log:', err);
  }
}

module.exports = { logActivity };
