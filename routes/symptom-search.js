// routes/symptom-search.js
// بحث عن الأصناف بالحالة/العرض (اللي انت مضيفها لكل صنف) أو بالمادة الفعالة، مع فلترة اختيارية بالسن
const express = require('express');
const { query } = require('../db');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

router.get('/', async (req, res, next) => {
  try {
    const q = (req.query.q || '').trim();
    const age = req.query.age !== undefined && req.query.age !== '' ? parseFloat(req.query.age) : null;

    let results = [];

    if (q) {
      const params = [`%${q}%`];
      let ageFilter = '';

      // لو المستخدم حدد سن، نستبعد أي صنف مالوش السن ده ضمن نطاقه المسموح
      // (لو الصنف مفيهوش حد سن مسجل أصلاً، بيفضل يظهر عادي من غير استبعاد)
      if (age !== null && !Number.isNaN(age)) {
        params.push(age);
        ageFilter += ` AND (min_age_years IS NULL OR min_age_years <= $${params.length})`;
        params.push(age);
        ageFilter += ` AND (max_age_years IS NULL OR max_age_years >= $${params.length})`;
      }

      results = await query(
        `SELECT * FROM medicines
         WHERE is_active = true
           AND (conditions_tags ILIKE $1 OR generic_name ILIKE $1 OR name ILIKE $1)
           ${ageFilter}
         ORDER BY
           CASE WHEN conditions_tags ILIKE $1 THEN 0 ELSE 1 END,
           lower(name)`,
        params
      );
    }

    res.render('symptom-search', { q, age: req.query.age || '', results, active: 'symptom-search' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
