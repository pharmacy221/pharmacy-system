const express = require('express');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  res.render('home', { role: req.session.role || null });
});

module.exports = router;
