import { db } from './db';
import { createClient } from '@supabase/supabase-js';

// الإعدادات من متغيرات البيئة (مفيش مفاتيح مكتوبة في الكود).
// Vite: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — أو SUPABASE_URL / SUPABASE_ANON_KEY خارج Vite.
const env = (typeof import.meta !== 'undefined' && import.meta.env) || (typeof process !== 'undefined' && process.env) || {};
const supabaseUrl = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const supabaseKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseKey) {
  throw new Error('لازم تحدد SUPABASE_URL و SUPABASE_ANON_KEY في متغيرات البيئة');
}
export const supabase = createClient(supabaseUrl, supabaseKey);

// تاريخ النهارده محليًا بصيغة YYYY-MM-DD (للمقارنة مع expiry_date)
function localToday() {
  return new Date().toLocaleDateString('en-CA');
}

export async function processSale(medicineId, requestedQty) {
  try {
    // التشغيلات الصالحة فقط: كمية متبقية وصلاحية لسه ما انتهتش
    const today = localToday();
    const localBatches = await db.batches
      .where('medicine_id')
      .equals(medicineId)
      .filter(b => b.quantity > 0 && String(b.expiry_date).slice(0, 10) >= today)
      .toArray();

    if (localBatches.length === 0) {
      throw new Error('عذراً، لا توجد كمية صالحة (غير منتهية) من هذا الدواء في المخزون المحلي.');
    }

    localBatches.sort((a, b) => new Date(a.expiry_date) - new Date(b.expiry_date));

    let remainingQtyToSell = requestedQty;
    const deductions = [];

    for (const batch of localBatches) {
      if (remainingQtyToSell <= 0) break;

      const qtyFromThisBatch = Math.min(batch.quantity, remainingQtyToSell);
      batch.quantity -= qtyFromThisBatch;
      await db.batches.put(batch);

      deductions.push({
        batch_id: batch.id,
        sold_qty: qtyFromThisBatch
      });

      remainingQtyToSell -= qtyFromThisBatch;
    }

    if (remainingQtyToSell > 0) {
      throw new Error('الكمية المطلوبة تتجاوز المتاح في المخزون حالياً.');
    }

    const salePayload = {
      medicine_id: medicineId,
      deductions: deductions,
      sold_at: new Date().toISOString()
    };

    if (navigator.onLine) {
      const { error } = await supabase.from('sales').insert([salePayload]);
      if (error) throw error;
    } else {
      await db.sync_queue.add({
        type: 'SALE',
        data: salePayload,
        timestamp: new Date().toISOString(),
        status: 'pending'
      });
    }

    return { success: true, message: 'تمت عملية البيع بنجاح' };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
