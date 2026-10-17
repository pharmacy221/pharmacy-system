import { db } from './db';
import { supabase } from './salesService';

export function initAutoSync() {
  window.addEventListener('online', async () => {
    try {
      const pendingItems = await db.sync_queue
        .where('status')
        .equals('pending')
        .toArray();

      if (pendingItems.length === 0) return;

      for (const item of pendingItems) {
        if (item.type === 'SALE') {
          const { error } = await supabase.from('sales').insert([item.data]);
          if (!error) {
            await db.sync_queue.update(item.id, { status: 'synced' });
          }
        }
      }
    } catch (error) {
      console.error('حدث خطأ أثناء المزامنة:', error);
    }
  });
}
