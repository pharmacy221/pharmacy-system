# HANDOFF — حالة إصلاحات نظام الصيدلية

> **الحالة: كل البنود اتنفذت.** التفاصيل والاختبارات والمخاطر في FINAL_REPORT.md. القسم التالي تاريخي.


## المشروع
النسخة الأحدث هي المجلد الخارجي (pharmacy-system-main/). المجلد المتداخل pharmacy-system-main/pharmacy-system-main نسخة قديمة، لم أعدّلها.
Node + Express + EJS + PostgreSQL (Supabase). لا يوجد إطار اختبارات في المشروع.

## تم إنجازه (ومُجرَّب على Postgres 16 محلي بـ psql)
- db/migration_002_integrity_fixes.sql (idempotent، أُعيد تشغيله بنجاح)، يتضمن:
  - pharmacy_tz()/pharmacy_today() (افتراضي Africa/Cairo، من settings.timezone)
  - FEFO جديد: يستبعد المنتهي، قفل صف الصنف، تسجيل التشغيلة لكل بند في sale_item_batches، حركات في stock_movements
  - stock_units تتحدث فقط بتريجر على batches (مصدر الحقيقة = التشغيلات)، وUPDATE مباشر عليها مرفوض
  - منع حذف الفواتير وبنودها؛ void_sale_invoice() بدل الحذف (يعكس المتبقي فقط، لا يرجّع منتهي، يسجل رد النقدية، يمنع التكرار)
  - create_return() (مرتبط ببند البيع، المبلغ بعد نصيب الخصم، رد على نفس التشغيلة، idempotency، حركة خزنة)
  - adjust_medicine_stock() للتسوية بدل التعديل المباشر
  - finalize_sale_invoice() (الإجمالي والخصم من البنود + حركة خزنة + إلزام shift_id)
  - cash_movements، shift_summary()، record_shift_cash()، close_shift() (يمنع الإغلاق المزدوج ويحسب العجز/الزيادة)
  - report_sales_summary()/report_sales_daily()/report_top_medicines() (بدون تكرار JOIN، تستبعد الملغاة، بتوقيت الصيدلية)
  - view v_stock_batch_mismatch (تقرير فروق، قراءة فقط)
- JS مُعدَّل: lib/errors.js (جديد)، middleware/auth.js (requireRole)، routes/pos.js (checkout + عرض المخزون الصالح)،
  routes/sales.js (void)، routes/returns.js (+ صلاحية admin/pharmacist)، views: pos.ejs, sales.ejs, sale-detail.ejs, returns.ejs.
  تم فحص الصياغة فقط بـ node --check — لم تُشغَّل لأن سجل npm محجوب في بيئتي.

## متبقٍّ
1. routes/products.js: إضافة صنف برصيد افتتاحي ← إنشاء تشغيلة (تاريخ الصلاحية من حقل expiry-add، أعطه name="opening_expiry" في products.ejs)؛ stock_dirty ← adjust_medicine_stock داخل transaction؛ batches/add ← requireRole('admin','pharmacist') + التحقق (كمية>0، تكلفة>=0، صلاحية غير منتهية).
2. routes/shifts.js + views/shifts.ejs: استخدام shift_summary وclose_shift، نموذج إيداع/سحب (record_shift_cash)، عرض المتوقع والعجز، وإصلاح todayStr (UTC) للحضور.
3. routes/reports.js وroutes/dashboard.js: استبدال استعلامات JOIN بدوال report_* (revenue = net_sales)، وتواريخ اليوم من pharmacy_today().
4. routes/activity-log.js: إضافة labels للحقول الجديدة (refund_amount, restored_units, difference...).
5. src/salesService.js: مفتاح Supabase مكتوب داخل الكود (يلزم تدويره) + لا يفلتر المنتهي؛ الملف غير مستخدم فعليًا.
6. db/migration_002_rollback.sql، db/report-stock-mismatch.js، db/migrate.js، package.json (script test).
7. الاختبارات (node:test بدون حزم): عبر psql للطبقة SQL (FEFO، إلغاء، مرتجعات، تزامن بجلستين، ورديات، تقارير)، + اختبار requireRole. لم تُكتب بعد.
8. ملف تقرير نهائي.

## قرارات مهمة
- المرتجعات: admin/pharmacist فقط. الإلغاء: admin. استلام التشغيلات: admin/pharmacist.
- رد نقدي (مرتجع/إلغاء) يتطلب وردية مفتوحة للمستخدم.
- تشغيلة منتهية لا يُرجَع إليها مخزون في الإلغاء/المرتجع.
- فروق المخزون القديمة لا تُصحَّح تلقائيًا.
- ترتيب التشغيل: pharmacy_schema.sql → migration_forms.sql → migration_002_integrity_fixes.sql. خذ pg_dump أولًا.
