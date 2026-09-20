const express = require('express');
const { db } = require('../db');
const { authRequired } = require('../middleware/auth');

const router = express.Router();
router.use(authRequired);

function pad(n) { return n < 10 ? '0' + n : '' + n; }
function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

// Builds a day-by-day running stock ledger for every product, from the earliest
// recorded entry (or the target end date, if there's no history yet) through endDate.
function buildLedger(endDate) {
  const products = db.prepare('SELECT * FROM products WHERE archived = 0').all();
  const firstRow = db.prepare('SELECT MIN(date) d FROM entries').get();
  let start = firstRow.d && firstRow.d < endDate ? firstRow.d : endDate;

  const allEntries = db.prepare('SELECT * FROM entries WHERE date <= ? ORDER BY date ASC').all(endDate);
  const byDate = {};
  allEntries.forEach(e => { (byDate[e.date] = byDate[e.date] || []).push(e); });

  const running = {};
  products.forEach(p => { running[p.id] = p.initial_stock; });

  const dates = [];
  let cursor = start;
  // Safety cap so a malformed date range can't loop forever.
  let guard = 0;
  while (cursor <= endDate && guard < 4000) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
    guard++;
  }

  const ledger = {};
  dates.forEach(date => {
    const dayEntries = byDate[date] || [];
    ledger[date] = {};
    products.forEach(p => {
      const opening = running[p.id] ?? 0;
      let added = 0, discarded = 0, actual = null;
      dayEntries.forEach(e => {
        if (e.product_id !== p.id) return;
        if (e.type === 'add') added += e.qty;
        else if (e.type === 'discard') discarded += e.qty;
        else if (e.type === 'actual') actual = e.qty;
      });
      const systemStock = opening + added - discarded;
      const variance = actual !== null ? actual - systemStock : null;
      const closing = actual !== null ? actual : systemStock;
      ledger[date][p.id] = { opening, added, discarded, systemStock, actual, variance, closing };
      running[p.id] = closing;
    });
  });

  return { ledger, products, dates };
}

router.get('/day', (req, res) => {
  const date = req.query.date || todayStr();
  const { ledger, products } = buildLedger(date);
  res.json({ date, products, ledger: ledger[date] || {} });
});

router.get('/month', (req, res) => {
  const month = req.query.month; // YYYY-MM
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });

  const today = todayStr();
  const currentMonth = today.slice(0, 7);
  const monthEndCandidate = month + '-31';
  const endDate = month === currentMonth ? today : (month < currentMonth ? month + '-28' : month + '-01');
  // Use a safe end-of-month bound by walking forward from the 1st.
  let realEnd = month + '-01';
  for (let i = 0; i < 31; i++) {
    const next = addDays(realEnd, 1);
    if (!next.startsWith(month)) break;
    realEnd = next;
  }
  const finalEnd = month === currentMonth ? today : realEnd;

  const { ledger, products, dates } = buildLedger(finalEnd);
  const monthDates = dates.filter(d => d.startsWith(month));
  const agg = {};
  products.forEach(p => { agg[p.id] = { added: 0, discarded: 0, daysCounted: 0, lastClosing: 0 }; });
  monthDates.forEach(d => {
    products.forEach(p => {
      const l = ledger[d][p.id];
      agg[p.id].added += l.added;
      agg[p.id].discarded += l.discarded;
      if (l.actual !== null) agg[p.id].daysCounted++;
      agg[p.id].lastClosing = l.closing;
    });
  });
  res.json({ month, products, agg, daysInMonth: monthDates.length });
});

router.get('/year', (req, res) => {
  const year = req.query.year || String(new Date().getFullYear());
  const today = todayStr();
  const currentYear = today.slice(0, 4);
  const endDate = year === currentYear ? today : year + '-12-31';

  const { ledger, products, dates } = buildLedger(endDate);
  const months = Array.from({ length: 12 }).map((_, i) => year + '-' + pad(i + 1));
  const perMonth = months.map(m => {
    const mDates = dates.filter(d => d.startsWith(m));
    let added = 0, discarded = 0;
    mDates.forEach(d => {
      products.forEach(p => {
        added += ledger[d][p.id].added;
        discarded += ledger[d][p.id].discarded;
      });
    });
    return { month: m, added, discarded, hasData: mDates.length > 0 };
  });
  res.json({ year, perMonth });
});

router.get('/movers', (req, res) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const endDate = todayStr();
  const startDate = addDays(endDate, -(days - 1));

  const { ledger, products, dates } = buildLedger(endDate);
  const periodDates = dates.filter(d => d >= startDate && d <= endDate);

  const stats = products.map(p => {
    let added = 0, discarded = 0, lastMoveDate = null;
    periodDates.forEach(d => {
      const l = ledger[d][p.id];
      added += l.added; discarded += l.discarded;
      if (l.added > 0 || l.discarded > 0) lastMoveDate = d;
    });
    const turnover = added + discarded;
    const daysIdle = lastMoveDate
      ? Math.round((new Date(endDate) - new Date(lastMoveDate)) / 86400000)
      : null;
    return { product: p, added, discarded, turnover, daysIdle };
  });

  res.json({ days, stats });
});

module.exports = router;
