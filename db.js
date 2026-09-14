const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

// DATABASE_PATH (full file path) takes priority if set — matches the convention
// used by other services in this Railway account. Falls back to DATA_DIR/inventory.db.
const DB_PATH = process.env.DATABASE_PATH || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'inventory.db');
const DB_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// File attachments live on the same persistent volume as the database, so they
// survive redeploys the same way the DB does — not in the app's ephemeral filesystem.
const UPLOADS_DIR = path.join(DB_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','staff')),
      pin_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'pcs',
      initial_stock REAL NOT NULL DEFAULT 0,
      reorder_level REAL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      product_id TEXT NOT NULL REFERENCES products(id),
      type TEXT NOT NULL CHECK(type IN ('add','discard','actual')),
      qty REAL NOT NULL,
      reason TEXT DEFAULT '',
      user_id INTEGER REFERENCES users(id),
      staff_name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_by TEXT,
      edited_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
    CREATE INDEX IF NOT EXISTS idx_entries_product ON entries(product_id);
    CREATE INDEX IF NOT EXISTS idx_entries_date_product ON entries(date, product_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      clock_in TEXT NOT NULL,
      clock_out TEXT,
      notes TEXT DEFAULT '',
      edited_by TEXT,
      edited_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_time_user_date ON time_entries(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(date);

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      barcode TEXT,
      recipe TEXT,
      recipe_image TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_menu_barcode ON menu_items(barcode);

    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      invoice_no TEXT,
      date TEXT NOT NULL,
      items_json TEXT NOT NULL,
      subtotal REAL NOT NULL,
      vat_amount REAL NOT NULL DEFAULT 0,
      discount_type TEXT DEFAULT '',
      discount_amount REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL,
      payment_method TEXT NOT NULL,
      order_type TEXT NOT NULL DEFAULT 'takeout',
      status TEXT NOT NULL DEFAULT 'pending',
      served_by TEXT,
      served_at TEXT,
      voided_by TEXT,
      voided_at TEXT,
      void_reason TEXT,
      customer_name TEXT,
      shift_id TEXT,
      cashier_id INTEGER REFERENCES users(id),
      cashier_name TEXT,
      voided INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(date);

    -- Atomically incrementing counters for sequential, gap-free invoice numbering.
    -- One row per cashier shift at the register — opened with a starting cash
    -- float, closed at turnover with a counted amount and computed variance.
    CREATE TABLE IF NOT EXISTS cashier_shifts (
      id TEXT PRIMARY KEY,
      cashier_id INTEGER REFERENCES users(id),
      cashier_name TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      starting_cash REAL NOT NULL DEFAULT 0,
      counted_cash REAL,
      expected_cash REAL,
      variance REAL,
      sales_total REAL,
      sales_count INTEGER,
      sales_by_method TEXT,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      verified_by TEXT,
      verified_by_id INTEGER,
      verified_at TEXT,
      verified_amount REAL
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_cashier ON cashier_shifts(cashier_id);
    CREATE INDEX IF NOT EXISTS idx_shifts_status ON cashier_shifts(status);

    CREATE TABLE IF NOT EXISTS counters (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    );

    -- Refunds are their own immutable record, never edits to the original sale —
    -- the original stays exactly as issued, the refund is a separate credit memo.
    CREATE TABLE IF NOT EXISTS refunds (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      invoice_no TEXT,
      amount REAL NOT NULL,
      reason TEXT NOT NULL,
      refunded_by TEXT,
      refunded_by_id INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_refunds_sale ON refunds(sale_id);

    -- Append-only audit trail for anything BIR (or you) would want to see: voids,
    -- refunds, tax/pricing setting changes, and data resets. Never updated, only inserted.
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      user_id INTEGER,
      user_name TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

    CREATE TABLE IF NOT EXISTS attendance_status (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('absent','awol','undertime')),
      notes TEXT DEFAULT '',
      marked_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_status(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_status(date);

    CREATE TABLE IF NOT EXISTS break_entries (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('break','lunch')),
      start_time TEXT NOT NULL,
      end_time TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_break_user_date ON break_entries(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_break_date ON break_entries(date);

    CREATE TABLE IF NOT EXISTS shifts (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      notes TEXT DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_shifts_user_date ON shifts(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_shifts_date ON shifts(date);

    CREATE TABLE IF NOT EXISTS policies (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      category TEXT DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS notices (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('schedule','contract','warning','penalty','memo')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      requires_ack INTEGER NOT NULL DEFAULT 1,
      issued_by TEXT,
      issued_by_id INTEGER REFERENCES users(id),
      attachment_filename TEXT,
      attachment_stored_name TEXT,
      attachment_mimetype TEXT,
      email_status TEXT,
      email_error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_notices_user ON notices(user_id);

    CREATE TABLE IF NOT EXISTS notice_acks (
      id TEXT PRIMARY KEY,
      notice_id TEXT NOT NULL REFERENCES notices(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      acknowledged_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notice_ack_unique ON notice_acks(notice_id, user_id);

    -- One submission per person per week — resubmitting the same week updates it.
    CREATE TABLE IF NOT EXISTS availability_submissions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      week_start TEXT NOT NULL,
      days_json TEXT NOT NULL,
      notes TEXT DEFAULT '',
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_avail_user_week ON availability_submissions(user_id, week_start);

    CREATE TABLE IF NOT EXISTS leave_requests (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      admin_notes TEXT,
      reviewed_by TEXT,
      reviewed_at TEXT,
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status);

    CREATE TABLE IF NOT EXISTS feedback_submissions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      category TEXT NOT NULL DEFAULT 'feedback',
      message TEXT NOT NULL,
      admin_reply TEXT,
      replied_by TEXT,
      replied_at TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- HR documents (ID photo, NBI/police/barangay clearance) — one row per doc
    -- type per employee; re-uploading the same type replaces the file.
    CREATE TABLE IF NOT EXISTS staff_documents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      doc_type TEXT NOT NULL,
      original_filename TEXT,
      stored_filename TEXT NOT NULL,
      mimetype TEXT,
      uploaded_by TEXT,
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_doc_unique ON staff_documents(user_id, doc_type);

    -- Flags a clock-in as late or outside any scheduled shift. Created
    -- automatically at clock-in time; needs a reason and admin approval.
    CREATE TABLE IF NOT EXISTS schedule_exceptions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      user_name TEXT,
      date TEXT NOT NULL,
      time_entry_id TEXT,
      type TEXT NOT NULL,
      scheduled_start TEXT,
      actual_clock_in TEXT,
      minutes_late INTEGER,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by TEXT,
      reviewed_at TEXT,
      admin_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sched_exc_user_date ON schedule_exceptions(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_sched_exc_status ON schedule_exceptions(status);
  `);

  // Migration-safe column add for existing deployments (products table predates barcode).
  const productCols = db.prepare("PRAGMA table_info(products)").all().map(c => c.name);
  if (!productCols.includes('barcode')) {
    db.exec('ALTER TABLE products ADD COLUMN barcode TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode)');
  }

  // Migration-safe column add for existing deployments (menu_items predates recipes).
  const menuCols = db.prepare("PRAGMA table_info(menu_items)").all().map(c => c.name);
  if (!menuCols.includes('recipe')) {
    db.exec('ALTER TABLE menu_items ADD COLUMN recipe TEXT');
  }
  if (!menuCols.includes('recipe_image')) {
    db.exec('ALTER TABLE menu_items ADD COLUMN recipe_image TEXT');
  }

  // Migration-safe column add in case feedback_submissions already existed without reply support.
  const feedbackCols = db.prepare("PRAGMA table_info(feedback_submissions)").all().map(c => c.name);
  ['admin_reply', 'replied_by', 'replied_at'].forEach(col => {
    if (!feedbackCols.includes(col)) db.exec(`ALTER TABLE feedback_submissions ADD COLUMN ${col} TEXT`);
  });
  if (!feedbackCols.includes('status')) {
    db.exec("ALTER TABLE feedback_submissions ADD COLUMN status TEXT NOT NULL DEFAULT 'open'");
  }

  // Migration-safe column add for existing deployments (sales table predates kitchen tracking).
  // New default of 'served' means pre-existing sales don't clutter the kitchen queue.
  const salesCols = db.prepare("PRAGMA table_info(sales)").all().map(c => c.name);
  if (!salesCols.includes('order_type')) {
    db.exec("ALTER TABLE sales ADD COLUMN order_type TEXT NOT NULL DEFAULT 'takeout'");
  }
  if (!salesCols.includes('status')) {
    db.exec("ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'served'");
  }
  if (!salesCols.includes('served_by')) {
    db.exec('ALTER TABLE sales ADD COLUMN served_by TEXT');
  }
  if (!salesCols.includes('served_at')) {
    db.exec('ALTER TABLE sales ADD COLUMN served_at TEXT');
  }
  ['invoice_no', 'voided_by', 'voided_at', 'void_reason', 'customer_name', 'shift_id'].forEach(col => {
    if (!salesCols.includes(col)) db.exec(`ALTER TABLE sales ADD COLUMN ${col} TEXT`);
  });
  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_invoice_no ON sales(invoice_no)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sales_shift ON sales(shift_id)');

  // Migration-safe column add for existing deployments (users table predates hourly_rate).
  const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userCols.includes('hourly_rate')) {
    db.exec('ALTER TABLE users ADD COLUMN hourly_rate REAL NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('email')) {
    db.exec('ALTER TABLE users ADD COLUMN email TEXT');
  }
  if (!userCols.includes('position')) {
    db.exec('ALTER TABLE users ADD COLUMN position TEXT');
  }
  [
    'address', 'emergency_contact', 'date_of_birth', 'tin', 'sss_number',
    'philhealth_number', 'pagibig_number', 'contact_number', 'education',
    'date_hired', 'termination_date', 'hr_notes'
  ].forEach(col => {
    if (!userCols.includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  });

  // Migration-safe column add for existing deployments (cashier_shifts predates verification).
  const shiftCols = db.prepare("PRAGMA table_info(cashier_shifts)").all().map(c => c.name);
  if (!shiftCols.includes('verified_by')) {
    db.exec('ALTER TABLE cashier_shifts ADD COLUMN verified_by TEXT');
    db.exec('ALTER TABLE cashier_shifts ADD COLUMN verified_by_id INTEGER');
    db.exec('ALTER TABLE cashier_shifts ADD COLUMN verified_at TEXT');
    db.exec('ALTER TABLE cashier_shifts ADD COLUMN verified_amount REAL');
  }

  // Migration-safe column add in case notices table already existed without these.
  const noticeCols = db.prepare("PRAGMA table_info(notices)").all().map(c => c.name);
  ['attachment_filename', 'attachment_stored_name', 'attachment_mimetype', 'email_status', 'email_error'].forEach(col => {
    if (!noticeCols.includes(col)) db.exec(`ALTER TABLE notices ADD COLUMN ${col} TEXT`);
  });

  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const defaultPin = process.env.DEFAULT_ADMIN_PIN || '1234';
    const hash = bcrypt.hashSync(defaultPin, 10);
    db.prepare('INSERT INTO users (name, role, pin_hash) VALUES (?,?,?)').run('Admin', 'admin', hash);
    console.log('---------------------------------------------------------');
    console.log(`Seeded default admin account — PIN: ${defaultPin}`);
    console.log('Log in and change this immediately under Admin > Team.');
    console.log('---------------------------------------------------------');
  }

  const defaults = {
    cafe_name: 'After Hours Art Cafe',
    vat_rate: '12',
    senior_pwd_discount: '20',
    ot_multiplier: '1.25',
    standard_hours: '8',
    break_limit_minutes: '15',
    lunch_limit_minutes: '60',
    late_grace_minutes: '10',
    notice_reply_to: '',
    attention_note: '',
    business_name: 'After Hours Art Cafe',
    business_address: '',
    business_tin: '',
    vat_registered: 'yes',
    invoice_prefix: 'OR',
    facebook_page: '',
    receipt_footer_note: '',
    logo_filename: '',
    theme: 'dark',
    schedule_exception_minutes: '14'
  };
  Object.entries(defaults).forEach(([key, value]) => {
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (!existing) db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(key, value);
  });
}

module.exports = { db, initDb, UPLOADS_DIR };
