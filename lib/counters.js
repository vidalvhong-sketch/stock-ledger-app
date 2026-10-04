const { db } = require('../db');

// Atomically increments a named counter and returns the new value. Using a real
// row-level UPDATE (not read-then-write in JS) keeps this safe even if two
// checkouts happen at nearly the same moment — SQLite serializes the writes.
function nextSequence(key) {
  db.prepare('INSERT INTO counters (key, value) VALUES (?, 0) ON CONFLICT(key) DO NOTHING').run(key);
  db.prepare('UPDATE counters SET value = value + 1 WHERE key = ?').run(key);
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key);
  return row.value;
}

function nextInvoiceNumber(prefix) {
  const n = nextSequence('invoice');
  return (prefix || 'OR') + '-' + String(n).padStart(6, '0');
}

function nextCreditMemoNumber() {
  const n = nextSequence('credit_memo');
  return 'CM-' + String(n).padStart(6, '0');
}

module.exports = { nextSequence, nextInvoiceNumber, nextCreditMemoNumber };
