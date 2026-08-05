import Dexie from 'dexie';

export const db = new Dexie('PharmacyHybridDB');

db.version(1).stores({
  medicines: 'id, name, barcode',
  batches: 'id, medicine_id, expiry_date, quantity, cost',
  sync_queue: '++id, type, data, timestamp, status'
});
