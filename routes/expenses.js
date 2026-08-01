// routes/expenses.js
const express = require('express');
const { query } = require('../db');
const { requireLogin, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activity-log');

const router = express.Router();
router.use(requireLogin, requireAdmin);

router.get('/', async (req, res, next) => {
  try {
    const from = req.query.from || new Date().toISOString().slice(0, 8) + '01';
    const to = req.query.to || new Date().toISOString().slice(0, 10);

    const expensesList = await query(
      `SELECT expenses.*, expense_categories.name AS category_name
       FROM expenses
       LEFT JOIN expense_categories ON expense_categories.id = expenses.category_id
       WHERE expenses.expense_date BETWEEN $1 AND $2
       ORDER BY expenses.expense_date DESC, expenses.id DESC`,
      [from, to]
    );

    const categories = await query('SELECT * FROM expense_categories ORDER BY name');

    const byCategory = await query(
      `SELECT COALESCE(expense_categories.name, expenses.category_name_snapshot, 'أخرى') AS category_name,
              SUM(expenses.amount) AS total
       FROM expenses
       LEFT JOIN expense_categories ON expense_categories.id = expenses.category_id
       WHERE expenses.expense_date BETWEEN $1 AND $2
       GROUP BY COALESCE(expense_categories.name, expenses.category_name_snapshot, 'أخرى')
       ORDER BY total DESC`,
      [from, to]
    );

    const total = expensesList.reduce((sum, e) => sum + Number(e.amount), 0);

    res.render('expenses', { expensesList, categories, byCategory, total, from, to, active: 'expenses' });
  } catch (err) {
    next(err);
  }
});

router.post('/add', async (req, res, next) => {
  const { category_id, new_category_name, amount, expense_date, notes } = req.body;
  try {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return res.status(400).send('قيمة المصروف غير صحيحة');

    let finalCategoryId = category_id || null;
    let categoryNameSnapshot = null;

    // لو المستخدم كتب تصنيف جديد مش موجود في القائمة
    if (new_category_name && new_category_name.trim()) {
      const inserted = await query(
        `INSERT INTO expense_categories (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [new_category_name.trim()]
      );
      finalCategoryId = inserted[0].id;
      categoryNameSnapshot = new_category_name.trim();
    } else if (finalCategoryId) {
      const cat = await query('SELECT name FROM expense_categories WHERE id = $1', [finalCategoryId]);
      categoryNameSnapshot = cat[0] ? cat[0].name : null;
    }

    await query(
      `INSERT INTO expenses (category_id, category_name_snapshot, amount, expense_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [finalCategoryId, categoryNameSnapshot, amt, expense_date || new Date().toISOString().slice(0, 10), notes || null, req.session.userId]
    );

    await logActivity(req, { action: 'تسجيل مصروف', entityType: 'expense', details: { amount: amt, category: categoryNameSnapshot } });
    res.redirect('/expenses');
  } catch (err) {
    next(err);
  }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    await query('DELETE FROM expenses WHERE id = $1', [req.params.id]);
    res.redirect('/expenses');
  } catch (err) {
    next(err);
  }
});

module.exports = router;
