// lib/errors.js
// تمييز أخطاء "قواعد العمل" (رسالتها آمنة تتعرض للمستخدم) عن الأخطاء الداخلية (بتتسجل في الـ console بس).
//
// دوال قاعدة البيانات بترمي أخطاء بكود SQLSTATE بيبدأ بـ PH:
//   PH001 = قاعدة عمل / تحقق (400)    PH002 = غير موجود (404)    PH003 = تكرار / اتنفذت قبل كده (409)

class BusinessError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'BusinessError';
    this.status = status;
  }
}

function isBusinessError(err) {
  return err instanceof BusinessError || (err && typeof err.code === 'string' && err.code.startsWith('PH'));
}

function statusFor(err) {
  if (err instanceof BusinessError) return err.status;
  if (err && err.code === 'PH002') return 404;
  if (err && err.code === 'PH003') return 409;
  if (isBusinessError(err)) return 400;
  if (err && (err.code === '40P01' || err.code === '40001' || err.code === '55P03')) return 409;
  if (err && err.code === '23514') return 409;
  return 500;
}

// الرسالة اللي تتعرض للمستخدم. أي خطأ داخلي بيرجع الـ fallback بدل تفاصيل SQL.
function userMessage(err, fallback = 'حصل خطأ غير متوقع، حاول تاني') {
  if (isBusinessError(err)) return err.message;
  if (err && err.code === '23514') return 'فيه تعارض في كميات المخزون للصنف ده؛ راجع المسؤول (تقرير فروق المخزون)';
  if (err && (err.code === '40P01' || err.code === '40001' || err.code === '55P03')) {
    return 'العملية اتعارضت مع عملية تانية في نفس الوقت، حاول تاني';
  }
  return fallback;
}

// مفتاح منع التكرار (Idempotency Key): نص قصير آمن، أو null لو مش صالح
function cleanKey(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^[A-Za-z0-9:_.\-]{8,120}$/.test(s) ? s : null;
}

module.exports = { BusinessError, isBusinessError, statusFor, userMessage, cleanKey };
