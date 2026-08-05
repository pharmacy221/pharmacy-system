import { db } from './db';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = 'https://cdxodmngppuvddblsmxw.supabase.co/rest/v1/';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNkeG9kbW5ncHB1dmRkYmxzbXh3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1NDAwMTMsImV4cCI6MjEwMTExNjAxM30.YBo0wm2sO9sc2ehtDcP-gGYkhqedykDqD8bhAcSE9NI';
export const supabase = createClient(supabaseUrl, supabaseKey);

export async function processSale(medicineId, requestedQty) {
  try {
    const localBatches = await db.batches
      .where('medicine_id')
      .equals(medicineId)
      .filter(b => b.quantity > 0)
      .toArray();

    if (localBatches.length === 0) {
      throw new Error('عذراً، هذا الدواء غير متوفر في المخزون المحلي.');
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
