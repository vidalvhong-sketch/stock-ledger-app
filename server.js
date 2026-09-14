require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./db');

initDb();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/products', require('./routes/products'));
app.use('/api/entries', require('./routes/entries'));
app.use('/api/ledger', require('./routes/ledger'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/time', require('./routes/time'));
app.use('/api/menu', require('./routes/menu'));
app.use('/api/sales', require('./routes/sales'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/policies', require('./routes/policies'));
app.use('/api/notices', require('./routes/notices'));
app.use('/api/branding', require('./routes/branding'));
app.use('/api/recipe-image', require('./routes/recipe-images'));
app.use('/api/shifts', require('./routes/shifts'));
app.use('/api/requests', require('./routes/requests'));
app.use('/api/staff-documents', require('./routes/staff-documents'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Serve the SPA for any non-API route.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stock Ledger listening on port ${PORT}`);
});
