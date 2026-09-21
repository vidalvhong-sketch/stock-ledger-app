/* ============================= API HELPER ============================= */
let TOKEN = localStorage.getItem('sl_token') || null;

const KIOSK_PATHS = ['/api/time/kiosk-lookup', '/api/time/kiosk-action'];

async function api(path, opts = {}) {
  const isFormData = opts.body instanceof FormData;
  const headers = Object.assign(isFormData ? {} : { 'Content-Type': 'application/json' }, opts.headers || {});
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  const isKioskPath = KIOSK_PATHS.some(p => path.startsWith(p));
  // A 401 from the kiosk endpoints means "wrong email/PIN for whoever's using the kiosk" —
  // it has nothing to do with the real logged-in session, and must never log that person out.
  if (res.status === 401 && !isKioskPath) {
    TOKEN = null;
    localStorage.removeItem('sl_token');
    state.user = null;
    state.loginStep = 'pin';
    render();
    throw new Error('Session expired');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.data = data; // callers that need extra response fields (e.g. needsDiscountApproval) can check e.data
    throw err;
  }
  return data;
}

/* ============================= DATE HELPERS ============================= */
function pad(n) { return n < 10 ? '0' + n : '' + n; }
function toISO(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
function todayStr() { return toISO(new Date()); }
function monthStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
function fmtDateLong(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtMonthLong(iso) {
  const d = new Date(iso + '-01T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
}
function fmtTime(sqliteUtc) {
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC.
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}
function fmtDateTimeShort(sqliteUtc) {
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toISO(d);
}
function fmtMoney(n) {
  return '₱' + Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function hoursLabel(h) {
  const hrs = Math.floor(h);
  const mins = Math.round((h - hrs) * 60);
  return hrs + 'h ' + pad(mins) + 'm';
}
function utcToLocalInput(sqliteUtc) {
  if (!sqliteUtc) return '';
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function localInputToUtc(val) {
  if (!val) return null;
  const d = new Date(val);
  const p2 = n => n < 10 ? '0' + n : '' + n;
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds());
}
// UI-only check for what a Manager can see — the server always re-checks
// live on every actual request, so a stale value here can never grant real access.
function iCan(permKey) {
  if (!state.user) return false;
  if (state.user.role === 'admin') return true;
  if (state.user.role !== 'manager') return false;
  return !!(state.user.managerPermissions && state.user.managerPermissions[permKey]);
}
function iCanApprove() {
  return state.user && (state.user.role === 'admin' || state.user.role === 'team_lead' || iCan('approve_discounts_refunds_voids'));
}

function escapeHtml(str) {
  if (str === undefined || str === null) return '';
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ============================= STATE ============================= */
let state = {
  booted: false,
  user: null,
  loginStep: 'pin',
  pinBuffer: '',
  pinError: false,
  pinBusy: false,
  kioskMode: false,
  kioskPinBuffer: '',
  kioskBusy: false,
  kioskLookup: null,
  kioskActionBusy: false,
  kioskConfirmingAction: null,
  kioskReasonInput: '',
  kioskEmailInput: '',
  kioskResult: null,
  kioskError: false,
  kioskErrorMessage: '',
  showInlineKiosk: false,
  showHrDetails: false,
  permissionDefs: [],
  staffDocuments: {},
  liveRoster: null,

  cafeName: 'Stock Ledger',
  products: [],

  appMode: 'inventory', // 'inventory' | 'pos' | 'time'
  tab: 'dashboard',
  loadingTab: false,
  toast: null,

  dayLedger: null,   // {date, products, ledger}
  todayEntries: [],
  monthLedger: null,
  yearLedger: null,
  moversData: null,
  users: [],
  settings: {},

  formProductId: '',
  formQty: '',
  formReason: '',
  countInputs: {},

  reportMode: 'daily',
  reportDate: todayStr(),
  reportMonth: monthStr(new Date()),
  reportYear: new Date().getFullYear(),
  moversPeriod: 30,

  adminSection: 'products',
  editProduct: null,
  editUser: null,
  teamSortBy: 'name',
  teamFilterRole: '',
  teamFilterStatus: '',
  editDate: todayStr(),
  confirmModal: null,
  resetTypeInput: '',
  reasonInput: '',
  amountInput: '',

  // ---- POS ----
  menuItems: [],
  cart: [], // [{itemId, name, price, qty}]
  posCategory: 'All',
  posDiscount: '', // '' | 'senior_pwd'
  posOrderType: 'dine_in', // 'dine_in' | 'takeout' | 'delivery' | 'food_panda'
  posCustomerName: '',
  posPayment: '',
  posCashTendered: '',
  salesDate: todayStr(),
  salesList: [],
  salesSummary: null,
  refundsList: [],
  editMenuItem: null,
  recipeViewingId: null,
  editingRecipeId: null,
  recipeDraft: '',

  // Kitchen queue
  kitchenOrders: [],
  kitchenIncludeServed: false,
  showDevicesPanel: false,
  btPrinterConnected: false,
  btPrinterName: '',
  btScannerConnected: false,
  btScannerName: '',

  // ---- Time Clock ----
  clockStatus: null, // {clockedIn, entry}
  myTimeEntries: [],
  teamTimeDate: todayStr(),
  teamTimeEntries: [],
  editTimeEntry: null,
  payrollStart: daysAgoISO(6),
  payrollEnd: todayStr(),
  payrollData: null,

  // Breaks / lunch
  breakStatus: null, // {onBreak, entry}
  myTodayBreaks: [],
  teamBreaks: [],

  // Attendance marking (admin)
  statusMarks: [],
  markAttendance: null, // {userId, date, status, notes}

  // Evaluation report (day/week/month/year/custom)
  evalMode: 'month',
  evalDate: todayStr(),
  evalWeek: currentIsoWeekString(new Date()),
  evalMonth: monthStr(new Date()),
  evalYear: new Date().getFullYear(),
  evalCustomStart: daysAgoISO(6),
  evalCustomEnd: todayStr(),
  evalData: null,

  // Barcode scanning
  scanBarcode: '',

  // POS receipt
  lastSale: null,
  pickingVariantFor: null,
  discountApprovalPending: false,
  discountApprovalEmailInput: '',
  discountApprovalPinBuffer: '',
  discountApprovalBusy: false,
  discountApprovalError: '',
  pendingDiscountToken: null,
  isOnline: navigator.onLine,
  offlineQueue: [],
  syncingOffline: false,
  businessInfo: {},

  // Cashier shifts / turnover
  currentShift: null,
  activeCashierShift: null,
  activeCashierSummary: null,
  verifyingShift: null,
  verifyAmountInput: '',
  verifyEmailInput: '',
  verifyPinBuffer: '',
  verifyBusy: false,
  verifyError: '',
  shiftSummary: null,
  showStartShiftPanel: false,
  showTurnoverPanel: false,
  startingCashInput: '',
  turnoverCountedCash: '',
  turnoverNotes: '',
  turnoverResult: null,
  shiftsHistory: [],
  approvalRequests: [],
  approvalsFilter: 'pending',
  shiftsStart: daysAgoISO(6),
  shiftsEnd: todayStr(),

  // Top-level Admin overview
  overviewData: null,
  liveStatus: null,
  attentionNote: '',
  editingAttentionNote: false,
  attentionNoteDraft: '',
  auditLogEntries: [],
  auditFilterAction: '',
  auditStart: daysAgoISO(29),
  auditEnd: todayStr(),

  // Scheduling
  scheduleDate: todayStr(),
  scheduleShifts: [],
  scheduleCoverage: null,
  editShift: null,

  // HR: Notices & Policies
  hrSection: 'notices',
  notices: [],
  policies: [],
  editPolicy: null,
  newNotice: null,
  emailConfigured: false,

  // Staff Requests: Availability / Leave / Feedback
  requestsSection: 'availability',
  availabilityWeek: '',
  myAvailability: null,
  allAvailability: [],
  availDaysDraft: {},
  availNotesDraft: '',
  leaveForm: { startDate: '', endDate: '', reason: '', notes: '' },
  myLeaveRequests: [],
  allLeaveRequests: [],
  leaveFilter: '',
  feedbackCategory: 'feedback',
  feedbackMessage: '',
  allFeedback: [],
  exceptionFilter: 'pending',
  allExceptions: [],
  myFeedback: [],
  replyingFeedbackId: null,
  feedbackReplyDraft: '',
};

function toast(msg, kind = 'accent') {
  const id = Date.now() + Math.random();
  state.toast = { msg, kind, id };
  render();
  setTimeout(() => { if (state.toast && state.toast.id === id) { state.toast = null; render(); } }, 2600);
}

/* ============================= LOGIN ============================= */
function pressDigit(d) {
  if (state.pinBuffer.length >= 8) return;
  state.pinError = false;
  state.pinBuffer += d;
  render();
}
function backspaceDigit() { state.pinBuffer = state.pinBuffer.slice(0, -1); render(); }

async function submitPin() {
  if (state.pinBuffer.length < 4) { toast('PIN must be at least 4 digits.', 'bad'); return; }
  state.pinBusy = true; render();
  try {
    const data = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ pin: state.pinBuffer }) });
    TOKEN = data.token;
    localStorage.setItem('sl_token', TOKEN);
    state.user = data.user;
    state.pinBuffer = '';
    state.pinBusy = false;
    state.tab = 'dashboard';
    await loadCore();
    render();
    await switchTab('dashboard');
  } catch (e) {
    state.pinError = true;
    state.pinBuffer = '';
    state.pinBusy = false;
    render();
  }
}

function logout() {
  TOKEN = null;
  localStorage.removeItem('sl_token');
  state = Object.assign(state, { user: null, loginStep: 'pin', pinBuffer: '', pinError: false, tab: 'dashboard', kioskMode: false });
  render();
}

/* ============================= CORE DATA LOAD ============================= */
async function loadCore() {
  const [products, settings] = await Promise.all([
    api('/api/products'),
    state.user.role === 'admin' ? api('/api/admin/settings') : Promise.resolve({})
  ]);
  state.products = products;
  if (state.user.role === 'admin') {
    state.settings = settings;
    if (settings.cafe_name) state.cafeName = settings.cafe_name;
  } else {
    // staff can still see the cafe name via a lightweight public-ish call; fall back gracefully.
    state.cafeName = state.cafeName || 'Stock Ledger';
  }
}

/* ============================= APP / TAB DATA LOADING ============================= */
const DEFAULT_TAB = { inventory: 'dashboard', pos: 'register', time: 'clock', admin: 'overview' };

async function switchApp(mode) {
  if (state.appMode === mode) return;
  stopKitchenPolling();
  stopOverviewPolling();
  stopClockRosterPolling();
  state.appMode = mode;
  state.tab = DEFAULT_TAB[mode];
  state.loadingTab = true;
  render();
  try {
    await loadTabData(state.tab);
  } catch (e) {
    toast(e.message || 'Something went wrong loading that.', 'bad');
  }
  state.loadingTab = false;
  render();
  if (mode === 'pos' && state.tab === 'kitchen') startKitchenPolling();
  if (mode === 'admin' && state.tab === 'overview') startOverviewPolling();
  if (mode === 'time' && state.tab === 'clock') startClockRosterPolling();
}

async function switchTab(tab) {
  stopKitchenPolling();
  stopOverviewPolling();
  stopClockRosterPolling();
  state.tab = tab;
  state.loadingTab = true;
  render();
  try {
    await loadTabData(tab);
  } catch (e) {
    toast(e.message || 'Something went wrong loading that.', 'bad');
  }
  state.loadingTab = false;
  render();
  if (state.appMode === 'pos' && tab === 'kitchen') startKitchenPolling();
  if (state.appMode === 'admin' && tab === 'overview') startOverviewPolling();
  if (state.appMode === 'time' && tab === 'clock') startClockRosterPolling();
}

async function loadTabData(tab) {
  if (state.appMode === 'inventory') {
    if (tab === 'dashboard') {
      const [day, entries] = await Promise.all([
        api('/api/ledger/day?date=' + todayStr()),
        api('/api/entries?date=' + todayStr())
      ]);
      state.dayLedger = day;
      state.todayEntries = entries;
    } else if (tab === 'count') {
      state.dayLedger = await api('/api/ledger/day?date=' + todayStr());
    } else if (tab === 'reports') {
      await loadReportData();
    } else if (tab === 'movers') {
      state.moversData = await api('/api/ledger/movers?days=' + state.moversPeriod);
    } else if (tab === 'admin') {
      await loadAdminSectionData(state.adminSection);
    }
    // add / discard tabs just need state.products, already loaded at login
  } else if (state.appMode === 'admin') {
    if (tab === 'overview') {
      await loadAdminOverview();
    } else if (tab === 'team') {
      const [users, permDefs] = await Promise.all([api('/api/users'), api('/api/users/permissions')]);
      state.users = users;
      state.permissionDefs = permDefs;
    } else if (tab === 'audit') {
      await loadAuditLog();
    } else if (tab === 'settings') {
      state.settings = await api('/api/admin/settings');
    }
  } else if (state.appMode === 'pos') {
    await loadCurrentShift();
    if (tab === 'register') {
      if (state.menuItems.length === 0) state.menuItems = await api('/api/menu');
      state.businessInfo = await api('/api/admin/public').catch(() => ({}));
    } else if (tab === 'kitchen') {
      await loadKitchenQueue();
    } else if (tab === 'recipes') {
      state.menuItems = await api('/api/menu');
    } else if (tab === 'history') {
      await loadSalesHistory();
    } else if (tab === 'shifts') {
      await loadShiftsHistory();
    } else if (tab === 'approvals') {
      await loadApprovals();
    } else if (tab === 'items') {
      state.menuItems = await api('/api/menu');
    }
  } else if (state.appMode === 'time') {
    if (tab === 'clock') {
      const [status, mine, brk, myBreaks, publicSettings, roster] = await Promise.all([
        api('/api/time/status'),
        api('/api/time/entries?date=' + todayStr()),
        api('/api/time/break-status'),
        api('/api/time/breaks?date=' + todayStr()),
        api('/api/admin/public').catch(() => ({ attention_note: '' })),
        api('/api/time/live-status').catch(() => null)
      ]);
      state.clockStatus = status;
      state.myTimeEntries = mine;
      state.breakStatus = brk;
      state.myTodayBreaks = myBreaks;
      state.attentionNote = publicSettings.attention_note || '';
      state.liveRoster = roster;
    } else if (tab === 'team') {
      await loadTeamDay();
    } else if (tab === 'schedule') {
      await loadSchedule();
    } else if (tab === 'hr') {
      await loadHrData();
    } else if (tab === 'requests') {
      await loadRequestsData();
    } else if (tab === 'payroll') {
      await loadPayroll();
    } else if (tab === 'eval') {
      await loadEvalData();
    }
  }
}

async function loadAuditLog() {
  const params = new URLSearchParams({ start: state.auditStart, end: state.auditEnd });
  if (state.auditFilterAction) params.set('action', state.auditFilterAction);
  state.auditLogEntries = await api('/api/admin/audit-log?' + params.toString());
}

async function loadAdminOverview() {
  const today = todayStr();
  const [day, entries, salesSummary, timeEntries, statusMarks, liveStatus, settings] = await Promise.all([
    api('/api/ledger/day?date=' + today),
    api('/api/entries?date=' + today),
    api('/api/sales/summary?date=' + today).catch(() => null),
    api('/api/time/entries?date=' + today),
    api('/api/time/status-marks?date=' + today),
    api('/api/time/live-status'),
    api('/api/admin/settings')
  ]);
  const products = await api('/api/products');
  const ledger = day.ledger || {};
  const lowStock = products.filter(p => {
    const l = ledger[p.id]; if (!l) return false;
    return p.reorder_level !== '' && p.reorder_level !== null && p.reorder_level !== undefined && l.closing <= Number(p.reorder_level);
  });
  state.overviewData = {
    lowStockCount: lowStock.length,
    addsToday: entries.filter(e => e.type === 'add').length,
    discardsToday: entries.filter(e => e.type === 'discard').length,
    salesTotal: salesSummary ? salesSummary.grossTotal : 0,
    salesCount: salesSummary ? salesSummary.transactionCount : 0,
    clockedInCount: timeEntries.filter(e => !e.clock_out).length,
    attendanceIssues: statusMarks.length
  };
  state.liveStatus = liveStatus;
  state.settings = settings;
}

let overviewPollTimer = null;
function startOverviewPolling() {
  stopOverviewPolling();
  overviewPollTimer = setInterval(async () => {
    if (state.appMode === 'admin' && state.tab === 'overview') {
      try { await loadAdminOverview(); render(); } catch (e) { /* silent */ }
    } else {
      stopOverviewPolling();
    }
  }, 15000);
}
function stopOverviewPolling() {
  if (overviewPollTimer) { clearInterval(overviewPollTimer); overviewPollTimer = null; }
}

let clockRosterPollTimer = null;
function startClockRosterPolling() {
  stopClockRosterPolling();
  clockRosterPollTimer = setInterval(async () => {
    if (state.appMode === 'time' && state.tab === 'clock') {
      try {
        state.liveRoster = await api('/api/time/live-status');
        render();
      } catch (e) { /* silent */ }
    } else {
      stopClockRosterPolling();
    }
  }, 20000);
}
function stopClockRosterPolling() {
  if (clockRosterPollTimer) { clearInterval(clockRosterPollTimer); clockRosterPollTimer = null; }
}

async function loadReportData() {
  if (state.reportMode === 'daily' || state.reportMode === 'comparison') {
    const [day, entries] = await Promise.all([
      api('/api/ledger/day?date=' + state.reportDate),
      api('/api/entries?date=' + state.reportDate)
    ]);
    state.dayLedger = day;
    state.todayEntries = entries;
  } else if (state.reportMode === 'monthly') {
    state.monthLedger = await api('/api/ledger/month?month=' + state.reportMonth);
  } else {
    state.yearLedger = await api('/api/ledger/year?year=' + state.reportYear);
  }
}

async function loadAdminSectionData(section) {
  if (section === 'products') {
    state.products = await api('/api/products');
  } else if (section === 'log') {
    state.todayEntries = await api('/api/entries?date=' + state.editDate);
  }
}

/* ============================= ENTRY ACTIONS ============================= */
async function addStockEntry() {
  if (!state.formProductId || !state.formQty || Number(state.formQty) <= 0) {
    toast('Pick a product and enter a quantity above zero.', 'bad'); return;
  }
  try {
    await api('/api/entries', { method: 'POST', body: JSON.stringify({ productId: state.formProductId, type: 'add', qty: Number(state.formQty), reason: state.formReason }) });
    const pName = state.products.find(p => p.id === state.formProductId)?.name || 'Item';
    state.formProductId = ''; state.formQty = ''; state.formReason = '';
    toast(`Added stock: ${pName}`, 'good');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function discardStockEntry() {
  if (!state.formProductId || !state.formQty || Number(state.formQty) <= 0) {
    toast('Pick a product and enter a quantity above zero.', 'bad'); return;
  }
  if (!state.formReason) { toast('Select a reason for the discard.', 'bad'); return; }
  try {
    await api('/api/entries', { method: 'POST', body: JSON.stringify({ productId: state.formProductId, type: 'discard', qty: Number(state.formQty), reason: state.formReason }) });
    const pName = state.products.find(p => p.id === state.formProductId)?.name || 'Item';
    state.formProductId = ''; state.formQty = ''; state.formReason = '';
    toast(`Discarded stock: ${pName}`, 'bad');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function saveActualCount(productId, qtyStr) {
  if (qtyStr === '' || isNaN(Number(qtyStr))) return;
  try {
    await api('/api/entries/count', { method: 'POST', body: JSON.stringify({ productId, qty: Number(qtyStr) }) });
    toast('Count saved.', 'good');
    state.dayLedger = await api('/api/ledger/day?date=' + todayStr());
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function deleteEntryAction(id) {
  try {
    await api('/api/entries/' + id, { method: 'DELETE' });
    toast('Entry deleted.', 'accent');
    state.todayEntries = await api('/api/entries?date=' + state.editDate);
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function updateEntryAction(id, patch) {
  try {
    await api('/api/entries/' + id, { method: 'PUT', body: JSON.stringify(patch) });
    toast('Entry updated.', 'accent');
    state.todayEntries = await api('/api/entries?date=' + state.editDate);
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= PRODUCT ACTIONS ============================= */
async function saveProductAction(payload, id) {
  try {
    if (id) await api('/api/products/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/products', { method: 'POST', body: JSON.stringify(payload) });
    state.products = await api('/api/products');
    state.editProduct = null;
    toast('Product saved.', 'good');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteProductAction(id) {
  try {
    await api('/api/products/' + id, { method: 'DELETE' });
    state.products = await api('/api/products');
    toast('Product removed.', 'accent');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= USER (TEAM) ACTIONS ============================= */
async function saveUserAction(payload, id) {
  try {
    if (id) await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/users', { method: 'POST', body: JSON.stringify(payload) });
    state.users = await api('/api/users');
    state.editUser = null;
    toast('Team member saved.', 'good');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteUserAction(id) {
  try {
    const result = await api('/api/users/' + id, { method: 'DELETE' });
    state.users = await api('/api/users');
    toast(result.action === 'deactivated' ? 'This person has activity history, so they were deactivated instead — their past records stay intact.' : 'Team member removed.', 'accent');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function toggleActiveAction(id, makeActive) {
  try {
    await api('/api/users/' + id, { method: 'PUT', body: JSON.stringify({ active: makeActive }) });
    state.users = await api('/api/users');
    toast(makeActive ? 'Marked active.' : 'Marked inactive — they can no longer log in until reactivated.', 'accent');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= SETTINGS & RESET ============================= */
async function saveSettingsAction(payload) {
  try {
    await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(payload) });
    if (payload.cafe_name) state.cafeName = payload.cafe_name;
    toast('Settings saved.', 'good');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function resetTodayAction() {
  try {
    await api('/api/admin/reset-today', { method: 'POST' });
    toast("Today's entries cleared.", 'bad');
    state.confirmModal = null;
    await switchTab(state.tab);
  } catch (e) { toast(e.message, 'bad'); }
}
async function resetAllAction() {
  try {
    await api('/api/admin/reset-all', { method: 'POST', body: JSON.stringify({ confirm: state.resetTypeInput }) });
    toast('All inventory data has been reset.', 'bad');
    state.confirmModal = null;
    state.resetTypeInput = '';
    await switchTab(state.tab);
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= POS ACTIONS ============================= */
async function loadCurrentShift() {
  const [mine, active] = await Promise.all([
    api('/api/shifts/current'),
    api('/api/shifts/active')
  ]);
  state.currentShift = mine.shift;
  state.shiftSummary = mine.summary || null;
  state.activeCashierShift = active.shift;
  state.activeCashierSummary = active.summary || null;
}

async function startShiftAction(startingCash) {
  try {
    await api('/api/shifts/start', { method: 'POST', body: JSON.stringify({ startingCash }) });
    state.showStartShiftPanel = false;
    state.startingCashInput = '';
    toast('Shift started.', 'good');
    await loadCurrentShift();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function turnoverAction(countedCash, notes) {
  try {
    const closed = await api('/api/shifts/turnover', { method: 'POST', body: JSON.stringify({ countedCash, notes }) });
    state.turnoverResult = closed;
    state.showTurnoverPanel = false;
    state.turnoverCountedCash = ''; state.turnoverNotes = '';
    await loadCurrentShift();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function loadShiftsHistory() {
  state.shiftsHistory = await api(`/api/shifts?start=${state.shiftsStart}&end=${state.shiftsEnd}`);
}

async function loadApprovals() {
  const q = state.approvalsFilter ? '?status=' + state.approvalsFilter : '';
  try {
    state.approvalRequests = await api('/api/approvals/requests' + q);
  } catch (e) {
    state.approvalRequests = [];
    toast(e.message, 'bad');
  }
}

async function reviewApprovalAction(id, status) {
  try {
    await api('/api/approvals/requests/' + id + '/review', { method: 'PUT', body: JSON.stringify({ status }) });
    toast(status === 'approved' ? 'Approved.' : 'Denied.', status === 'approved' ? 'good' : 'accent');
    await loadApprovals();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= SHIFT TURNOVER VERIFICATION ============================= */
function openVerifyModal(shift) {
  state.verifyingShift = shift;
  state.verifyAmountInput = '';
  state.verifyEmailInput = '';
  state.verifyPinBuffer = '';
  state.verifyError = '';
  render();
}
function closeVerifyModal() {
  state.verifyingShift = null;
  render();
}
function verifyPressDigit(d) {
  if (state.verifyPinBuffer.length >= 8) return;
  state.verifyError = '';
  state.verifyPinBuffer += d;
  render();
}
function verifyBackspace() { state.verifyPinBuffer = state.verifyPinBuffer.slice(0, -1); render(); }

async function submitShiftVerification() {
  const amt = state.verifyAmountInput;
  if (amt === '' || isNaN(Number(amt)) || Number(amt) < 0) { state.verifyError = 'Enter the amount you actually counted.'; render(); return; }
  if (!state.verifyEmailInput.trim()) { state.verifyError = 'Enter your email.'; render(); return; }
  if (state.verifyPinBuffer.length < 4) { state.verifyError = 'Enter your PIN.'; render(); return; }

  state.verifyBusy = true; state.verifyError = ''; render();
  try {
    await api(`/api/shifts/${state.verifyingShift.id}/verify`, {
      method: 'PUT',
      body: JSON.stringify({ email: state.verifyEmailInput.trim(), pin: state.verifyPinBuffer, verifiedAmount: Number(amt) })
    });
    toast('Turnover verified.', 'good');
    state.verifyingShift = null;
    state.verifyBusy = false;
    await loadShiftsHistory();
    render();
  } catch (e) {
    state.verifyError = e.message;
    state.verifyBusy = false;
    render();
  }
}

function renderDiscountApprovalModal() {
  if (!state.discountApprovalPending) return '';
  const dots = Array.from({ length: Math.max(4, state.discountApprovalPinBuffer.length) }).map((_, i) =>
    `<span class="pin-dot ${i < state.discountApprovalPinBuffer.length ? 'filled' : ''}"></span>`).join('');
  return `
  <div class="modal-backdrop">
    <div class="card fade-in" style="max-width:340px;width:100%;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div class="font-display" style="font-size:17px;">Discount needs approval</div>
        <button id="closeDiscountApprovalBtn" style="background:none;border:none;color:var(--text-faint);font-size:22px;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">A Team Lead, Manager, or Admin needs to confirm this with their own email + PIN before checkout can continue.</div>
      <label>Approver's email</label>
      <input id="discountApprovalEmailField" type="email" placeholder="you@email.com" value="${escapeHtml(state.discountApprovalEmailInput)}" autocomplete="off"/>
      <div style="display:flex;gap:10px;justify-content:center;margin:14px 0 6px;">${dots}</div>
      ${state.discountApprovalError ? `<div style="color:var(--bad-soft);font-size:12.5px;margin-bottom:8px;">${escapeHtml(state.discountApprovalError)}</div>` : '<div style="height:19px;"></div>'}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map(k => {
          if (k === '⌫') return `<button class="keypad-btn" id="discountApprovalBack">⌫</button>`;
          if (k === '✓') return `<button class="keypad-btn enter" id="discountApprovalEnter" ${state.discountApprovalBusy ? 'disabled' : ''}>${state.discountApprovalBusy ? '…' : '✓'}</button>`;
          return `<button class="keypad-btn discount-approval-digit" data-d="${k}">${k}</button>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

function renderVerifyModal() {
  if (!state.verifyingShift) return '';
  const s = state.verifyingShift;
  const dots = Array.from({ length: Math.max(4, state.verifyPinBuffer.length) }).map((_, i) =>
    `<span class="pin-dot ${i < state.verifyPinBuffer.length ? 'filled' : ''}"></span>`).join('');
  return `
  <div class="modal-backdrop">
    <div class="card fade-in" style="max-width:360px;width:100%;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div class="font-display" style="font-size:17px;">Verify handoff</div>
        <button id="closeVerifyModalBtn" style="background:none;border:none;color:var(--text-faint);font-size:22px;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">${escapeHtml(s.cashier_name)} reported counting <b>${fmtMoney(s.counted_cash)}</b>. Enter what you actually received, then confirm with your own email + PIN.</div>
      <label>Amount you counted</label>
      <input id="verifyAmountField" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(state.verifyAmountInput)}"/>
      <div style="margin-top:12px;"><label>Your email</label><input id="verifyEmailField" type="email" placeholder="you@email.com" value="${escapeHtml(state.verifyEmailInput)}" autocomplete="off"/></div>
      <div style="display:flex;gap:10px;justify-content:center;margin:14px 0 6px;">${dots}</div>
      ${state.verifyError ? `<div style="color:var(--bad-soft);font-size:12.5px;margin-bottom:8px;">${escapeHtml(state.verifyError)}</div>` : '<div style="height:19px;"></div>'}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map(k => {
          if (k === '⌫') return `<button class="keypad-btn" id="verifyPinBack">⌫</button>`;
          if (k === '✓') return `<button class="keypad-btn enter" id="verifyPinEnter" ${state.verifyBusy ? 'disabled' : ''}>${state.verifyBusy ? '…' : '✓'}</button>`;
          return `<button class="keypad-btn verify-digit" data-d="${k}">${k}</button>`;
        }).join('')}
      </div>
    </div>
  </div>`;
}

async function loadSalesHistory() {
  const [list, summary, refunds] = await Promise.all([
    api('/api/sales?date=' + state.salesDate),
    api('/api/sales/summary?date=' + state.salesDate),
    state.user.role === 'admin' ? api('/api/sales/refunds?date=' + state.salesDate).catch(() => []) : Promise.resolve([])
  ]);
  state.salesList = list;
  state.salesSummary = summary;
  state.refundsList = refunds;
}

async function loadKitchenQueue() {
  const q = state.kitchenIncludeServed ? '?includeServed=1' : '';
  state.kitchenOrders = await api('/api/sales/kitchen' + q);
}

let kitchenPollTimer = null;
function startKitchenPolling() {
  stopKitchenPolling();
  kitchenPollTimer = setInterval(async () => {
    if (state.appMode === 'pos' && state.tab === 'kitchen') {
      try {
        await loadKitchenQueue();
        render();
      } catch (e) { /* silent - don't interrupt the crew screen on a transient error */ }
    } else {
      stopKitchenPolling();
    }
  }, 8000);
}
function stopKitchenPolling() {
  if (kitchenPollTimer) { clearInterval(kitchenPollTimer); kitchenPollTimer = null; }
}

async function markServedAction(id) {
  try {
    await api('/api/sales/' + id + '/serve', { method: 'POST', body: JSON.stringify({}) });
    await loadKitchenQueue();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function unserveAction(id) {
  try {
    await api('/api/sales/' + id + '/unserve', { method: 'POST', body: JSON.stringify({}) });
    await loadKitchenQueue();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

function addToCart(itemId, variantId) {
  const item = state.menuItems.find(i => i.id === itemId);
  if (!item) return;
  state.lastSale = null;
  const variant = variantId ? (item.variants || []).find(v => v.id === variantId) : null;
  const price = variant ? variant.price : item.price;
  const name = variant ? `${item.name} (${variant.name})` : item.name;
  const vid = variantId || null;
  const line = state.cart.find(l => l.itemId === itemId && l.variantId === vid);
  if (line) line.qty += 1;
  else state.cart.push({ itemId: item.id, variantId: vid, name, price, qty: 1 });
  render();
}
function changeCartQty(itemId, variantId, delta) {
  const vid = variantId || null;
  const line = state.cart.find(l => l.itemId === itemId && l.variantId === vid);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) state.cart = state.cart.filter(l => l !== line);
  render();
}
function clearCart() {
  state.cart = [];
  state.posDiscount = '';
  state.posPayment = '';
  state.posCashTendered = '';
  state.posCustomerName = '';
  render();
}

function cartTotals() {
  const vatRate = 0.12, discountRate = 0.20;
  const subtotal = state.cart.reduce((s, l) => s + l.price * l.qty, 0);
  const vatExclusive = subtotal / (1 + vatRate);
  const vatAmount = subtotal - vatExclusive;
  if (state.posDiscount === 'senior_pwd') {
    const discountAmount = vatExclusive * discountRate;
    return { subtotal, vatAmount: 0, discountAmount, total: vatExclusive - discountAmount };
  }
  return { subtotal, vatAmount, discountAmount: 0, total: subtotal };
}

/* ============================= OFFLINE SALE QUEUE ============================= */
const OFFLINE_QUEUE_KEY = 'sl_offline_sales';

function loadOfflineQueue() {
  try { state.offlineQueue = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]'); }
  catch (e) { state.offlineQueue = []; }
}
function saveOfflineQueue() {
  localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(state.offlineQueue));
}

// A failed fetch (not a server error response) means we're genuinely offline —
// the browser couldn't even reach the server, as opposed to the server
// responding with a validation error like "cart is empty".
function looksLikeNetworkFailure(e) {
  return !navigator.onLine || e instanceof TypeError;
}

function queueOfflineSale(payload, cartSnapshot) {
  const localId = 'offline-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  state.offlineQueue.push({ localId, payload, queuedAt: new Date().toISOString() });
  saveOfflineQueue();
  const total = cartTotals().total;
  toast(`Sale saved offline (₱${total.toFixed(2)}) — will sync once you're back online.`, 'accent');
  state.lastSale = { invoice_no: 'PENDING SYNC', total, payment_method: payload.paymentMethod, items: cartSnapshot, offline: true };
  clearCart();
  render();
}

async function syncOfflineQueue() {
  if (state.syncingOffline || state.offlineQueue.length === 0 || !navigator.onLine) return;
  state.syncingOffline = true; render();
  let synced = 0;
  // Sync in order and stop at the first failure — this keeps invoice numbering
  // sequential and avoids silently dropping a sale if the server rejects one.
  while (state.offlineQueue.length > 0) {
    const item = state.offlineQueue[0];
    try {
      await api('/api/sales/checkout', { method: 'POST', body: JSON.stringify(item.payload) });
      state.offlineQueue.shift();
      saveOfflineQueue();
      synced++;
    } catch (e) {
      if (looksLikeNetworkFailure(e)) break; // still offline after all, stop and retry later
      // A real server-side rejection (e.g. a menu item was since removed) — drop just this one so it doesn't block the rest.
      state.offlineQueue.shift();
      saveOfflineQueue();
      toast(`One offline sale couldn't sync and was skipped: ${e.message}`, 'bad');
    }
  }
  state.syncingOffline = false;
  if (synced > 0) toast(`Synced ${synced} offline sale${synced === 1 ? '' : 's'}.`, 'good');
  render();
}

async function checkoutAction() {
  if (state.cart.length === 0) { toast('Cart is empty.', 'bad'); return; }
  if (!state.posPayment) { toast('Select a payment method.', 'bad'); return; }
  const payload = {
    items: state.cart.map(l => ({ itemId: l.itemId, variantId: l.variantId || undefined, qty: l.qty })),
    discountType: state.posDiscount,
    paymentMethod: state.posPayment,
    orderType: state.posOrderType,
    customerName: state.posCustomerName
  };
  if (state.pendingDiscountToken) payload.discountApprovalToken = state.pendingDiscountToken;
  try {
    const sale = await api('/api/sales/checkout', { method: 'POST', body: JSON.stringify(payload) });
    state.pendingDiscountToken = null;
    toast(`Sale complete — ${fmtMoney(sale.total)}`, 'good');
    state.lastSale = Object.assign({}, sale, { items: state.cart.slice() });
    clearCart();
    render();
  } catch (e) {
    if (looksLikeNetworkFailure(e)) { queueOfflineSale(payload, state.cart.slice()); return; }
    if (e.data && e.data.needsDiscountApproval) { openDiscountApprovalModal(); return; }
    toast(e.message, 'bad');
  }
}

function openDiscountApprovalModal() {
  state.discountApprovalPending = true;
  state.discountApprovalEmailInput = '';
  state.discountApprovalPinBuffer = '';
  state.discountApprovalError = '';
  render();
}
function closeDiscountApprovalModal() { state.discountApprovalPending = false; render(); }
function discountApprovalPressDigit(d) {
  if (state.discountApprovalPinBuffer.length >= 8) return;
  state.discountApprovalError = '';
  state.discountApprovalPinBuffer += d;
  render();
}
function discountApprovalBackspace() { state.discountApprovalPinBuffer = state.discountApprovalPinBuffer.slice(0, -1); render(); }

async function submitDiscountApproval() {
  if (!state.discountApprovalEmailInput.trim()) { state.discountApprovalError = 'Enter the approver\'s email.'; render(); return; }
  if (state.discountApprovalPinBuffer.length < 4) { state.discountApprovalError = 'Enter the approver\'s PIN.'; render(); return; }
  state.discountApprovalBusy = true; state.discountApprovalError = ''; render();
  try {
    const result = await api('/api/approvals/discount-approval', {
      method: 'POST',
      body: JSON.stringify({ email: state.discountApprovalEmailInput.trim(), pin: state.discountApprovalPinBuffer, cashierId: state.user.id })
    });
    state.pendingDiscountToken = result.token;
    state.discountApprovalPending = false;
    state.discountApprovalBusy = false;
    toast(`Discount approved by ${result.approvedBy}.`, 'good');
    render();
    await checkoutAction(); // retry automatically now that we have a valid token
  } catch (e) {
    state.discountApprovalError = e.message;
    state.discountApprovalBusy = false;
    render();
  }
}

async function voidSaleAction(id, reason) {
  try {
    const result = await api('/api/sales/' + id, { method: 'DELETE', body: JSON.stringify({ reason }) });
    toast(result.pending ? 'Sent for approval — a Team Lead, Manager, or Admin needs to review it.' : 'Sale voided.', 'accent');
    state.confirmModal = null; state.reasonInput = '';
    await loadSalesHistory();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function refundSaleAction(id, amount, reason) {
  try {
    const refund = await api('/api/sales/' + id + '/refund', { method: 'POST', body: JSON.stringify({ amount, reason }) });
    toast(refund.pending ? 'Sent for approval — a Team Lead, Manager, or Admin needs to review it.' : `Refunded ${fmtMoney(refund.amount)} — ${refund.invoice_no}`, 'accent');
    state.confirmModal = null; state.reasonInput = ''; state.amountInput = '';
    await loadSalesHistory();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function saveMenuItemAction(payload, id) {
  try {
    if (id) await api('/api/menu/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/menu', { method: 'POST', body: JSON.stringify(payload) });
    state.menuItems = await api('/api/menu');
    state.editMenuItem = null;
    toast('Menu item saved.', 'good');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteMenuItemAction(id) {
  try {
    await api('/api/menu/' + id, { method: 'DELETE' });
    state.menuItems = await api('/api/menu');
    toast('Menu item removed.', 'accent');
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= TIME CLOCK ACTIONS ============================= */
function promptScheduleExceptionReason(exception) {
  if (!exception) return;
  const msg = exception.type === 'no_shift'
    ? "You clocked in without a shift scheduled today. Add a quick reason (e.g. covering for someone, forgot to check schedule) — admin will review it."
    : `You clocked in ${exception.minutes_late} min after your scheduled ${exception.scheduled_start} start. Add a reason — admin will review it.`;
  state.reasonInput = '';
  state.confirmModal = {
    title: 'One quick thing', body: msg,
    confirmLabel: 'Submit reason', requireReason: true, reasonPlaceholder: 'e.g. Swapped shift with Juan',
    onConfirm: async () => {
      try {
        await api('/api/time/schedule-exceptions/' + exception.id + '/reason', { method: 'PUT', body: JSON.stringify({ reason: state.reasonInput.trim() }) });
        state.confirmModal = null; state.reasonInput = '';
        toast('Thanks — sent to admin for review.', 'accent');
        render();
      } catch (e) { toast(e.message, 'bad'); }
    }
  };
  render();
}

async function clockInAction() {
  try {
    const result = await api('/api/time/clock-in', { method: 'POST', body: JSON.stringify({}) });
    toast('Clocked in.', 'good');
    state.clockStatus = await api('/api/time/status');
    state.myTimeEntries = await api('/api/time/entries?date=' + todayStr());
    render();
    if (result.scheduleException) promptScheduleExceptionReason(result.scheduleException);
  } catch (e) { toast(e.message, 'bad'); }
}
async function clockOutAction() {
  try {
    await api('/api/time/clock-out', { method: 'POST', body: JSON.stringify({}) });
    toast('Clocked out.', 'accent');
    state.clockStatus = await api('/api/time/status');
    state.myTimeEntries = await api('/api/time/entries?date=' + todayStr());
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function saveTimeEntryAction(id, patch) {
  try {
    await api('/api/time/entries/' + id, { method: 'PUT', body: JSON.stringify(patch) });
    toast('Punch updated.', 'accent');
    state.teamTimeEntries = await api('/api/time/entries?date=' + state.teamTimeDate);
    state.editTimeEntry = null;
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteTimeEntryAction(id) {
  try {
    await api('/api/time/entries/' + id, { method: 'DELETE' });
    toast('Punch deleted.', 'accent');
    state.teamTimeEntries = await api('/api/time/entries?date=' + state.teamTimeDate);
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function loadPayroll() {
  state.payrollData = await api(`/api/time/payroll?start=${state.payrollStart}&end=${state.payrollEnd}`);
}

async function loadTeamDay() {
  const [entries, breaks, marks, users] = await Promise.all([
    api('/api/time/entries?date=' + state.teamTimeDate),
    api('/api/time/breaks?date=' + state.teamTimeDate),
    api('/api/time/status-marks?date=' + state.teamTimeDate),
    api('/api/users')
  ]);
  state.teamTimeEntries = entries;
  state.teamBreaks = breaks;
  state.statusMarks = marks;
  state.users = users;
}

async function loadSchedule() {
  const [shifts, coverage, users] = await Promise.all([
    api('/api/schedule?date=' + state.scheduleDate),
    api('/api/schedule/coverage?date=' + state.scheduleDate),
    state.users.length === 0 ? api('/api/users') : Promise.resolve(state.users)
  ]);
  state.scheduleShifts = shifts;
  state.scheduleCoverage = coverage;
  state.users = users;
}

async function saveShiftAction(payload, id) {
  try {
    if (id) await api('/api/schedule/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/schedule', { method: 'POST', body: JSON.stringify(payload) });
    state.editShift = null;
    toast('Shift saved.', 'good');
    await loadSchedule();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteShiftAction(id) {
  try {
    await api('/api/schedule/' + id, { method: 'DELETE' });
    toast('Shift removed.', 'accent');
    await loadSchedule();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ============================= HR: NOTICES & POLICIES ============================= */
async function loadHrData() {
  const [notices, policies, users, emailStatus] = await Promise.all([
    api('/api/notices'),
    api('/api/policies'),
    state.user.role === 'admin' && state.users.length === 0 ? api('/api/users') : Promise.resolve(state.users),
    state.user.role === 'admin' ? api('/api/notices/email-status').catch(() => ({ configured: false })) : Promise.resolve(null)
  ]);
  state.notices = notices;
  state.policies = policies;
  state.users = users;
  if (emailStatus) state.emailConfigured = emailStatus.configured;
}

/* ============================= STAFF REQUESTS ============================= */
function nextMondayISO() {
  const d = new Date();
  const day = d.getDay();
  const daysUntilNextMon = ((8 - day) % 7) || 7;
  d.setDate(d.getDate() + daysUntilNextMon);
  return toISO(d);
}

async function loadRequestsData() {
  if (!state.availabilityWeek) state.availabilityWeek = nextMondayISO();

  if (state.requestsSection === 'availability') {
    if (state.user.role === 'admin') {
      state.allAvailability = await api('/api/requests/availability?week=' + state.availabilityWeek);
    } else {
      state.myAvailability = await api('/api/requests/availability/mine?week=' + state.availabilityWeek);
      state.availDaysDraft = state.myAvailability ? state.myAvailability.days : {};
      state.availNotesDraft = state.myAvailability ? state.myAvailability.notes : '';
    }
  } else if (state.requestsSection === 'leave') {
    if (state.user.role === 'admin') {
      const q = state.leaveFilter ? '?status=' + state.leaveFilter : '';
      state.allLeaveRequests = await api('/api/requests/leave' + q);
    } else {
      state.myLeaveRequests = await api('/api/requests/leave/mine');
    }
  } else if (state.requestsSection === 'feedback') {
    if (state.user.role === 'admin') {
      state.allFeedback = await api('/api/requests/feedback');
    } else {
      state.myFeedback = await api('/api/requests/feedback/mine');
    }
  } else if (state.requestsSection === 'exceptions') {
    const q = state.exceptionFilter ? '?status=' + state.exceptionFilter : '';
    state.allExceptions = await api('/api/time/schedule-exceptions' + q);
  }
}

async function submitAvailabilityAction() {
  try {
    await api('/api/requests/availability', {
      method: 'POST',
      body: JSON.stringify({ weekStart: state.availabilityWeek, days: state.availDaysDraft, notes: state.availNotesDraft })
    });
    toast('Availability submitted.', 'good');
    await loadRequestsData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function submitLeaveAction() {
  const f = state.leaveForm;
  if (!f.startDate || !f.endDate) { toast('Pick a start and end date.', 'bad'); return; }
  try {
    await api('/api/requests/leave', { method: 'POST', body: JSON.stringify(f) });
    toast('Leave request submitted.', 'good');
    state.leaveForm = { startDate: '', endDate: '', reason: '', notes: '' };
    await loadRequestsData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function reviewLeaveAction(id, status) {
  try {
    await api('/api/requests/leave/' + id, { method: 'PUT', body: JSON.stringify({ status }) });
    toast(status === 'approved' ? 'Request approved.' : 'Request denied.', status === 'approved' ? 'good' : 'accent');
    await loadRequestsData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function submitFeedbackAction() {
  if (!state.feedbackMessage.trim()) { toast('Write a message first.', 'bad'); return; }
  try {
    await api('/api/requests/feedback', { method: 'POST', body: JSON.stringify({ category: state.feedbackCategory, message: state.feedbackMessage }) });
    toast('Sent — thanks!', 'good');
    state.feedbackMessage = '';
    await loadRequestsData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function replyFeedbackAction(id, reply) {
  try {
    await api('/api/requests/feedback/' + id, { method: 'PUT', body: JSON.stringify({ adminReply: reply }) });
    toast('Reply sent.', 'good');
    state.replyingFeedbackId = null;
    state.feedbackReplyDraft = '';
    await loadRequestsData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function sendNoticeAction(formData) {
  try {
    await api('/api/notices', { method: 'POST', body: formData });
    toast('Notice sent.', 'good');
    state.newNotice = null;
    await loadHrData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteNoticeAction(id) {
  try {
    await api('/api/notices/' + id, { method: 'DELETE' });
    toast('Notice removed.', 'accent');
    await loadHrData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function acknowledgeNoticeAction(id) {
  try {
    await api('/api/notices/' + id + '/acknowledge', { method: 'POST', body: JSON.stringify({}) });
    toast('Acknowledged.', 'good');
    await loadHrData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function savePolicyAction(payload, id) {
  try {
    if (id) await api('/api/policies/' + id, { method: 'PUT', body: JSON.stringify(payload) });
    else await api('/api/policies', { method: 'POST', body: JSON.stringify(payload) });
    state.editPolicy = null;
    toast('Policy saved.', 'good');
    await loadHrData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deletePolicyAction(id) {
  try {
    await api('/api/policies/' + id, { method: 'DELETE' });
    toast('Policy removed.', 'accent');
    await loadHrData();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

async function loadEvalData() {
  let start, end;
  if (state.evalMode === 'day') { start = state.evalDate; end = state.evalDate; }
  else if (state.evalMode === 'week') {
    start = isoWeekToMonday(state.evalWeek);
    end = addDaysISO(start, 6);
  }
  else if (state.evalMode === 'month') {
    start = state.evalMonth + '-01';
    let e = start;
    for (let i = 0; i < 31; i++) { const n = addDaysISO(e, 1); if (!n.startsWith(state.evalMonth)) break; e = n; }
    end = e;
  } else if (state.evalMode === 'custom') { start = state.evalCustomStart; end = state.evalCustomEnd; }
  else { start = state.evalYear + '-01-01'; end = state.evalYear + '-12-31'; }
  state.evalData = await api(`/api/time/attendance-summary?start=${start}&end=${end}`);
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return toISO(d);
}
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week: weekNo };
}
function currentIsoWeekString(date) {
  const { year, week } = getISOWeek(date || new Date());
  return year + '-W' + pad(week);
}
function isoWeekToMonday(isoWeekStr) {
  const [yearStr, weekStr] = isoWeekStr.split('-W');
  const year = Number(yearStr), week = Number(weekStr);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4);
  week1Monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1);
  const targetMonday = new Date(week1Monday);
  targetMonday.setUTCDate(week1Monday.getUTCDate() + (week - 1) * 7);
  return targetMonday.toISOString().slice(0, 10);
}

/* ---- Breaks / lunch ---- */
async function startBreakAction(type) {
  try {
    await api('/api/time/break-start', { method: 'POST', body: JSON.stringify({ type }) });
    toast(type === 'lunch' ? 'Lunch started.' : 'Break started.', 'accent');
    state.breakStatus = await api('/api/time/break-status');
    state.myTodayBreaks = await api('/api/time/breaks?date=' + todayStr());
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function endBreakAction() {
  try {
    await api('/api/time/break-end', { method: 'POST', body: JSON.stringify({}) });
    toast('Back from break.', 'good');
    state.breakStatus = await api('/api/time/break-status');
    state.myTodayBreaks = await api('/api/time/breaks?date=' + todayStr());
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---- Attendance marking (admin) ---- */
async function saveAttendanceMarkAction(payload) {
  try {
    await api('/api/time/status-marks', { method: 'POST', body: JSON.stringify(payload) });
    toast('Attendance marked.', 'accent');
    state.markAttendance = null;
    await loadTeamDay();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
async function deleteAttendanceMarkAction(id) {
  try {
    await api('/api/time/status-marks/' + id, { method: 'DELETE' });
    toast('Attendance mark removed.', 'accent');
    await loadTeamDay();
    render();
  } catch (e) { toast(e.message, 'bad'); }
}

/* ---- Barcode scan (Add/Discard Stock) ---- */
async function scanBarcodeAction(code) {
  if (!code.trim()) return;
  try {
    const product = await api('/api/products/by-barcode/' + encodeURIComponent(code.trim()));
    state.formProductId = product.id;
    state.scanBarcode = '';
    toast(`Scanned: ${product.name}`, 'good');
    render();
    document.getElementById('af-qty')?.focus();
    document.getElementById('df-qty')?.focus();
  } catch (e) {
    state.scanBarcode = '';
    toast('No product with that barcode.', 'bad');
    render();
  }
}

/* ---- POS receipt printing ---- */
/* ---- Bluetooth devices (POS) ---- */
// Common BLE service/characteristic UUIDs used by many generic ESC/POS thermal
// printer modules. Not universal — printer BLE profiles vary a lot by vendor.
const BT_PRINTER_SERVICE_CANDIDATES = [
  '000018f0-0000-1000-8000-00805f9b34fb', // widely used by generic Chinese ESC/POS BLE printer modules
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip/ISSC serial-over-BLE, used by some printer boards
];

let btPrinterDevice = null;
let btPrinterCharacteristic = null;
let btScannerDevice = null;
let btScannerCharacteristic = null;

function bluetoothSupported() {
  return !!navigator.bluetooth;
}

async function connectBluetoothPrinter() {
  if (!bluetoothSupported()) { toast('Bluetooth is not available in this browser. Use Chrome on Android or Desktop.', 'bad'); return; }
  try {
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: BT_PRINTER_SERVICE_CANDIDATES
    });
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    let found = null;
    for (const service of services) {
      const chars = await service.getCharacteristics();
      const writable = chars.find(c => c.properties.write || c.properties.writeWithoutResponse);
      if (writable) { found = writable; break; }
    }
    if (!found) throw new Error('No writable channel found on this device — it may not support printing from a browser.');

    btPrinterDevice = device;
    btPrinterCharacteristic = found;
    state.btPrinterConnected = true;
    state.btPrinterName = device.name || 'Bluetooth printer';
    device.addEventListener('gattserverdisconnected', () => {
      state.btPrinterConnected = false;
      btPrinterDevice = null; btPrinterCharacteristic = null;
      toast('Printer disconnected.', 'accent');
      render();
    });
    toast(`Connected: ${state.btPrinterName}`, 'good');
    render();
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(e.message || 'Could not connect to printer.', 'bad');
  }
}
function disconnectBluetoothPrinter() {
  if (btPrinterDevice && btPrinterDevice.gatt.connected) btPrinterDevice.gatt.disconnect();
  state.btPrinterConnected = false; state.btPrinterName = '';
  btPrinterDevice = null; btPrinterCharacteristic = null;
  render();
}

async function connectBluetoothScanner() {
  if (!bluetoothSupported()) { toast('Bluetooth is not available in this browser. Use Chrome on Android or Desktop.', 'bad'); return; }
  try {
    const device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BT_PRINTER_SERVICE_CANDIDATES });
    const server = await device.gatt.connect();
    const services = await server.getPrimaryServices();
    let found = null;
    for (const service of services) {
      const chars = await service.getCharacteristics();
      const notifiable = chars.find(c => c.properties.notify);
      if (notifiable) { found = notifiable; break; }
    }
    if (!found) throw new Error("No scan-data channel found — this scanner likely works in keyboard mode instead, which needs no connection here.");

    await found.startNotifications();
    let buffer = '';
    found.addEventListener('characteristicvaluechanged', e => {
      const chunk = new TextDecoder().decode(e.target.value);
      buffer += chunk;
      if (buffer.includes('\n') || buffer.includes('\r')) {
        const code = buffer.replace(/[\r\n]/g, '').trim();
        buffer = '';
        if (code) scanBarcodeAction(code);
      }
    });

    btScannerDevice = device;
    btScannerCharacteristic = found;
    state.btScannerConnected = true;
    state.btScannerName = device.name || 'Bluetooth scanner';
    device.addEventListener('gattserverdisconnected', () => {
      state.btScannerConnected = false;
      btScannerDevice = null; btScannerCharacteristic = null;
      toast('Scanner disconnected.', 'accent');
      render();
    });
    toast(`Connected: ${state.btScannerName}`, 'good');
    render();
  } catch (e) {
    if (e.name !== 'NotFoundError') toast(e.message || 'Could not connect to scanner.', 'bad');
  }
}
function disconnectBluetoothScanner() {
  if (btScannerDevice && btScannerDevice.gatt.connected) btScannerDevice.gatt.disconnect();
  state.btScannerConnected = false; state.btScannerName = '';
  btScannerDevice = null; btScannerCharacteristic = null;
  render();
}

// Plain-text ESC/POS receipt — no logo/images, since raw bitmap printing over a
// generic write characteristic is a much bigger, printer-specific undertaking.
// The browser-print path (with logo) stays available as the full-featured option.
function buildEscPosReceipt(sale, biz) {
  const enc = new TextEncoder();
  const chunks = [];
  const ESC = 0x1B, GS = 0x1D;
  const push = (...bytes) => chunks.push(new Uint8Array(bytes));
  const line = (text = '') => chunks.push(enc.encode(text + '\n'));

  push(ESC, 0x40); // initialize
  push(ESC, 0x61, 0x01); // center align
  line(biz.business_name || 'Receipt');
  if (biz.business_address) line(biz.business_address);
  if (biz.business_tin) line('TIN: ' + biz.business_tin);
  line(biz.vat_registered === 'no' ? 'NON-VAT' : 'VAT REGISTERED');
  line('--------------------------------');
  line(sale.invoice_no || '');
  push(ESC, 0x61, 0x00); // left align
  line(new Date().toLocaleString());
  if (sale.customer_name) line('Customer: ' + sale.customer_name);
  line('--------------------------------');
  sale.items.forEach(i => line(`${i.name} x${i.qty}  ${fmtMoney(i.price * i.qty)}`));
  line('--------------------------------');
  line('Subtotal: ' + fmtMoney(sale.subtotal));
  if (sale.discount_amount > 0) line('Discount: -' + fmtMoney(sale.discount_amount));
  line('TOTAL: ' + fmtMoney(sale.total));
  line('Payment: ' + sale.payment_method);
  line('');
  if (biz.facebook_page) line('Follow us: ' + biz.facebook_page);
  if (biz.receipt_footer_note) line(biz.receipt_footer_note);
  line('Thank you!');
  line(''); line(''); line('');
  push(GS, 0x56, 0x00); // cut

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  chunks.forEach(c => { out.set(c, offset); offset += c.length; });
  return out;
}

async function printViaBluetooth(sale) {
  if (!btPrinterCharacteristic) { toast('No printer connected.', 'bad'); return; }
  try {
    const bytes = buildEscPosReceipt(sale, state.businessInfo || {});
    const CHUNK = 180; // conservative write size for wider BLE MTU compatibility
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.slice(i, i + CHUNK);
      if (btPrinterCharacteristic.properties.writeWithoutResponse) {
        await btPrinterCharacteristic.writeValueWithoutResponse(slice);
      } else {
        await btPrinterCharacteristic.writeValue(slice);
      }
    }
    toast('Sent to printer.', 'good');
  } catch (e) {
    toast('Print failed: ' + (e.message || 'unknown error'), 'bad');
  }
}

function printReceipt(sale, bizOverride, isPreview) {
  const win = window.open('', '_blank', 'width=380,height=680');
  if (!win) { toast('Allow pop-ups to print receipts.', 'bad'); return; }
  const biz = bizOverride || state.businessInfo || {};
  const isVat = biz.vat_registered !== 'no';
  const lines = sale.items.map(i => `
    <tr><td>${escapeHtml(i.name)} ×${i.qty}</td><td style="text-align:right;">${fmtMoney(i.price * i.qty)}</td></tr>
  `).join('');
  const vatableSales = sale.discount_amount > 0 ? 0 : (sale.subtotal - sale.vat_amount);
  const vatExemptSales = sale.discount_amount > 0 ? sale.total : 0;
  win.document.write(`
    <html><head><title>${isPreview ? 'Preview — ' : ''}${escapeHtml(sale.invoice_no || 'Receipt')}</title>
    <style>
      body{font-family:'Courier New',monospace;font-size:11.5px;width:280px;margin:0 auto;padding:16px 8px;color:#000;}
      h2{text-align:center;font-size:14px;margin:0 0 2px;}
      .sub{text-align:center;font-size:10px;margin-bottom:2px;}
      table{width:100%;border-collapse:collapse;}
      td{padding:2px 0;}
      hr{border:none;border-top:1px dashed #000;margin:8px 0;}
      .totals td{padding:1px 0;}
      .grand{font-weight:bold;font-size:13px;}
      .foot{text-align:center;margin-top:14px;font-size:9.5px;}
      .invno{text-align:center;font-weight:bold;font-size:12px;margin:6px 0;}
    </style></head>
    <body>
      ${isPreview ? `<div style="background:#000;color:#fff;text-align:center;padding:5px;font-weight:bold;font-size:11px;margin:-16px -8px 12px;">PREVIEW — SAMPLE DATA, NOT A REAL RECEIPT</div>` : ''}
      <div style="text-align:center;"><img src="${window.location.origin}/api/branding/logo" alt="logo" style="width:50px;height:50px;border-radius:50%;"/></div>
      <h2>${escapeHtml(biz.business_name || state.cafeName)}</h2>
      ${biz.business_address ? `<div class="sub">${escapeHtml(biz.business_address)}</div>` : ''}
      ${biz.business_tin ? `<div class="sub">TIN: ${escapeHtml(biz.business_tin)}</div>` : ''}
      <div class="sub">${isVat ? 'VAT REGISTERED' : 'NON-VAT'}</div>
      <hr/>
      <div class="invno">${escapeHtml(sale.invoice_no || '—')}</div>
      <div class="sub">Date: ${new Date(sale.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' })}</div>
      <div class="sub">Time: ${fmtTime(sale.created_at)}</div>
      <div class="sub">Order type: ${escapeHtml(orderTypeLabel(sale.order_type))}</div>
      ${sale.customer_name ? `<div class="sub">Customer: ${escapeHtml(sale.customer_name)}</div>` : ''}
      <hr/>
      <table>${lines}</table>
      <hr/>
      <table class="totals">
        <tr><td>Subtotal</td><td style="text-align:right;">${fmtMoney(sale.subtotal)}</td></tr>
        ${sale.discount_amount > 0 ? `<tr><td>Senior/PWD discount</td><td style="text-align:right;">−${fmtMoney(sale.discount_amount)}</td></tr>` : ''}
        <tr class="grand"><td>TOTAL</td><td style="text-align:right;">${fmtMoney(sale.total)}</td></tr>
      </table>
      ${isVat ? `
      <hr/>
      <table class="totals">
        <tr><td>VATable sales</td><td style="text-align:right;">${fmtMoney(vatableSales)}</td></tr>
        <tr><td>VAT-exempt sales</td><td style="text-align:right;">${fmtMoney(vatExemptSales)}</td></tr>
        <tr><td>VAT (12%)</td><td style="text-align:right;">${fmtMoney(sale.vat_amount)}</td></tr>
      </table>` : ''}
      <hr/>
      <div>Payment: ${escapeHtml(sale.payment_method)}</div>
      <div>Served by: ${escapeHtml(sale.cashier_name)}</div>
      <div class="foot">Thank you!<br/>This receipt is computer-generated.
      ${biz.facebook_page ? `<br/><br/>Follow us: ${escapeHtml(biz.facebook_page)}` : ''}
      ${biz.receipt_footer_note ? `<br/><br/>"${escapeHtml(biz.receipt_footer_note)}"` : ''}
      </div>
    </body></html>
  `);
  win.document.close();
  win.focus();
  if (!isPreview) setTimeout(() => win.print(), 250);
}

/* ============================= RENDER: ROOT ============================= */
function render() {
  const root = document.getElementById('app');
  if (!state.booted) { root.innerHTML = renderBoot(); return; }
  if (!state.user && state.kioskMode) { root.innerHTML = renderKiosk(); attachKioskHandlers(); return; }
  if (!state.user) { root.innerHTML = renderLogin(); attachLoginHandlers(); return; }
  root.innerHTML = renderShell();
  attachShellHandlers();
}

function renderBoot() {
  return `<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;">
    <div style="text-align:center;">
      <div class="font-display" style="font-size:22px;color:var(--accent-soft);">Stock Ledger</div>
      <div class="font-mono" style="color:var(--text-faint);font-size:12px;margin-top:6px;">loading…</div>
    </div>
  </div>`;
}

/* ============================= RENDER: LOGIN ============================= */
function renderLogin() {
  const dots = Array.from({ length: Math.max(4, state.pinBuffer.length) }).map((_, i) =>
    `<span class="pin-dot ${i < state.pinBuffer.length ? 'filled' : ''}"></span>`).join('');
  return `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;position:relative;background:#0d0906 url('/images/cover.jpg') center/cover no-repeat;">
    <div style="position:absolute;inset:0;background:linear-gradient(180deg, rgba(13,9,6,0.55) 0%, rgba(13,9,6,0.88) 55%, rgba(13,9,6,0.97) 100%);"></div>
    <div class="fade-in" style="position:relative;width:100%;max-width:340px;text-align:center;">
      <img src="/api/branding/logo" alt="${escapeHtml(state.cafeName)}" style="width:74px;height:74px;border-radius:50%;border:2px solid var(--border-soft);box-shadow:0 8px 24px rgba(0,0,0,0.5);"/>
      <div class="font-mono" style="letter-spacing:0.15em;color:var(--text-faint);font-size:11px;text-transform:uppercase;margin-top:16px;">${escapeHtml(state.cafeName)}</div>
      <div class="font-display" style="font-size:34px;color:var(--text);margin-top:6px;">Stock Ledger</div>
      <div style="color:var(--text-faint);font-size:13.5px;margin-top:6px;">Enter your PIN to clock in.</div>
      <div style="display:flex;gap:10px;justify-content:center;margin:26px 0 6px;">${dots}</div>
      ${state.pinError ? `<div style="color:var(--bad-soft);font-size:12.5px;margin-bottom:8px;">Incorrect PIN, try again.</div>` : '<div style="height:19px;"></div>'}
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:6px;">
        ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map(k => {
          if (k === '⌫') return `<button class="keypad-btn" id="pinBack">⌫</button>`;
          if (k === '✓') return `<button class="keypad-btn enter" id="pinEnter" ${state.pinBusy ? 'disabled' : ''}>${state.pinBusy ? '…' : '✓'}</button>`;
          return `<button class="keypad-btn pin-digit" data-d="${k}">${k}</button>`;
        }).join('')}
      </div>
      <button id="openKioskBtn" class="btn btn-ghost" style="margin-top:16px;padding:10px 18px;font-size:12.5px;">⏱ Quick Clock In/Out</button>
      <div style="color:var(--text-faint);font-size:11.5px;margin-top:22px;">First time here? The default admin PIN is <span class="font-mono">1234</span> — change it right away under Admin → Team.</div>
    </div>
  </div>`;
}

function attachLoginHandlers() {
  document.querySelectorAll('.pin-digit').forEach(b => b.addEventListener('click', () => pressDigit(b.getAttribute('data-d'))));
  document.getElementById('pinBack')?.addEventListener('click', backspaceDigit);
  document.getElementById('pinEnter')?.addEventListener('click', submitPin);
  document.getElementById('openKioskBtn')?.addEventListener('click', () => {
    state.kioskMode = true;
    state.kioskPinBuffer = ''; state.kioskResult = null; state.kioskError = false;
    render();
  });
}

/* ============================= KIOSK CLOCK IN/OUT ============================= */
function kioskPressDigit(d) {
  if (state.kioskPinBuffer.length >= 8) return;
  state.kioskError = false;
  state.kioskPinBuffer += d;
  render();
}
function kioskBackspace() { state.kioskPinBuffer = state.kioskPinBuffer.slice(0, -1); render(); }

async function submitKioskPin() {
  if (state.kioskPinBuffer.length < 4) { return; }
  state.kioskBusy = true; render();
  try {
    const data = await api('/api/time/kiosk-punch', { method: 'POST', body: JSON.stringify({ pin: state.kioskPinBuffer }) });
    state.kioskResult = data;
    state.kioskPinBuffer = '';
    state.kioskBusy = false;
    render();
    setTimeout(() => {
      if (state.kioskResult === data) { state.kioskResult = null; render(); } // only clear if a newer punch hasn't already replaced it
    }, 3000);
  } catch (e) {
    state.kioskError = true;
    state.kioskPinBuffer = '';
    state.kioskBusy = false;
    render();
  }
}

function kioskPressDigit(d) {
  if (state.kioskPinBuffer.length >= 8) return;
  state.kioskError = false;
  state.kioskPinBuffer += d;
  render();
}
function kioskBackspace() { state.kioskPinBuffer = state.kioskPinBuffer.slice(0, -1); render(); }

function kioskReset() {
  state.kioskPinBuffer = ''; state.kioskLookup = null; state.kioskResult = null; state.kioskError = false; state.kioskErrorMessage = ''; state.kioskConfirmingAction = null; state.kioskEmailInput = '';
}

async function submitKioskLookup() {
  if (state.kioskPinBuffer.length < 4) {
    state.kioskError = true;
    state.kioskErrorMessage = 'Enter your PIN.';
    render();
    return;
  }
  if (!state.kioskEmailInput.trim()) {
    state.kioskError = true;
    state.kioskErrorMessage = 'Enter your email.';
    render();
    return;
  }
  state.kioskBusy = true; state.kioskError = false; render();
  try {
    const data = await api('/api/time/kiosk-lookup', { method: 'POST', body: JSON.stringify({ email: state.kioskEmailInput.trim(), pin: state.kioskPinBuffer }) });
    state.kioskLookup = data; // email + PIN stay set — reused for the follow-up action call
    state.kioskBusy = false;
    render();
  } catch (e) {
    state.kioskError = true;
    state.kioskErrorMessage = "That email/PIN combination isn't on file. Double-check both, or ask admin to confirm your email is saved under Team.";
    state.kioskPinBuffer = '';
    state.kioskBusy = false;
    render();
  }
}

function cancelKioskLookup() { kioskReset(); render(); }

async function performKioskAction(action) {
  state.kioskActionBusy = true; render();
  try {
    const data = await api('/api/time/kiosk-action', { method: 'POST', body: JSON.stringify({ email: state.kioskEmailInput.trim(), pin: state.kioskPinBuffer, action }) });
    state.kioskResult = data;
    state.kioskLookup = null;
    state.kioskPinBuffer = '';
    state.kioskActionBusy = false;
    state.kioskReasonInput = '';
    render();
    if (!data.scheduleException) {
      setTimeout(() => {
        if (state.kioskResult === data) { state.kioskResult = null; render(); } // only clear if a newer action hasn't already replaced it
      }, 3000);
    }
  } catch (e) {
    state.kioskActionBusy = false;
    toast(e.message, 'bad');
    // refresh their status in case something changed, then let them pick again
    try { state.kioskLookup = await api('/api/time/kiosk-lookup', { method: 'POST', body: JSON.stringify({ email: state.kioskEmailInput.trim(), pin: state.kioskPinBuffer }) }); } catch (e2) { kioskReset(); }
    render();
  }
}

async function submitKioskExceptionReason() {
  const exc = state.kioskResult.scheduleException;
  if (!state.kioskReasonInput.trim()) { toast('Add a quick reason first.', 'bad'); return; }
  try {
    await api('/api/time/schedule-exceptions/' + exc.id + '/reason', { method: 'PUT', body: JSON.stringify({ reason: state.kioskReasonInput.trim() }) });
    toast('Thanks — sent to admin for review.', 'accent');
    state.kioskResult = null; state.kioskReasonInput = '';
    render();
  } catch (e) { toast(e.message, 'bad'); }
}
function skipKioskExceptionReason() {
  state.kioskResult = null; state.kioskReasonInput = '';
  render();
}

// Ending a break/lunch requires re-entering a PIN at that exact moment — a
// coworker who looked someone up earlier can't tap this on their behalf,
// since only the break-taker's own fresh PIN will pass the identity check below.
// Opens the modal straight at the "confirm it's you" step for a specific person
// and action — used by the per-row buttons on the Team roster. Still requires
// that exact person's own PIN before anything happens; this just skips the
// generic PIN-first lookup step since we already know who and what from the row.
function requestKioskRowAction(user, action, breakType) {
  state.kioskLookup = { userId: user.id, userName: user.name, breakType: breakType || null };
  state.kioskConfirmingAction = action;
  state.kioskPinBuffer = '';
  state.kioskError = false;
  state.showInlineKiosk = true;
  render();
}

function requestEndBreakConfirm() {
  state.kioskConfirmingAction = 'end_break';
  state.kioskPinBuffer = '';
  state.kioskError = false;
  render();
}

function cancelEndBreakConfirm() {
  state.kioskConfirmingAction = null;
  state.kioskPinBuffer = '';
  state.kioskError = false;
  render();
}

const KIOSK_ACTION_VERBS = {
  clock_in: 'clock in',
  clock_out: 'clock out',
  start_break: 'start your break',
  start_lunch: 'start your lunch',
  end_break: 'go back to your shift'
};

async function confirmEndBreakAction() {
  if (state.kioskPinBuffer.length < 4) {
    state.kioskError = true;
    state.kioskErrorMessage = 'Enter your PIN.';
    render();
    return;
  }
  if (!state.kioskEmailInput.trim()) {
    state.kioskError = true;
    state.kioskErrorMessage = 'Enter your email.';
    render();
    return;
  }
  const action = state.kioskConfirmingAction;
  state.kioskBusy = true; state.kioskError = false; render();
  try {
    const check = await api('/api/time/kiosk-lookup', { method: 'POST', body: JSON.stringify({ email: state.kioskEmailInput.trim(), pin: state.kioskPinBuffer }) });
    if (check.userId !== state.kioskLookup.userId) {
      state.kioskBusy = false;
      state.kioskPinBuffer = '';
      state.kioskError = true;
      state.kioskErrorMessage = `That's not ${state.kioskLookup.userName}'s email/PIN — only they can do this for themselves.`;
      render();
      return;
    }
    const data = await api('/api/time/kiosk-action', { method: 'POST', body: JSON.stringify({ email: state.kioskEmailInput.trim(), pin: state.kioskPinBuffer, action }) });
    state.kioskResult = data;
    state.kioskLookup = null;
    state.kioskConfirmingAction = null;
    state.kioskPinBuffer = '';
    state.kioskBusy = false;
    render();
    setTimeout(() => {
      if (state.kioskResult === data) { state.kioskResult = null; render(); }
    }, 3000);
  } catch (e) {
    state.kioskError = true;
    state.kioskErrorMessage = "That email/PIN combination isn't on file. Double-check both, or ask admin to confirm your email is saved under Team.";
    state.kioskPinBuffer = '';
    state.kioskBusy = false;
    render();
  }
}

function kioskActionButtons(lookup) {
  if (!lookup.clockedIn) return [['clock_in', 'Clock In', 'btn-good']];
  if (lookup.onBreak) return [['end_break', 'Back to Shift', 'btn-accent']];
  return [['start_break', 'Start Break', 'btn-ghost'], ['start_lunch', 'Start Lunch', 'btn-ghost'], ['clock_out', 'Clock Out', 'btn-bad']];
}

function renderKioskLookupPanel() {
  const l = state.kioskLookup;
  const statusLine = !l.clockedIn ? 'Currently clocked out'
    : l.onBreak ? `On ${l.breakType === 'lunch' ? 'lunch' : 'break'}`
    : `Clocked in since ${fmtTime(l.clockInSince)}`;
  return `
    <div class="font-display" style="font-size:20px;margin:6px 0 2px;">${escapeHtml(l.userName)}</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:18px;">${statusLine}</div>
    <div style="display:flex;flex-direction:column;gap:9px;">
      ${kioskActionButtons(l).map(([action, label, cls]) => `<button class="btn ${cls} kiosk-action-btn" data-action="${action}" style="padding:13px;" ${state.kioskActionBusy ? 'disabled' : ''}>${label}</button>`).join('')}
    </div>
    <button class="btn btn-ghost kiosk-cancel-btn" style="margin-top:14px;width:100%;">Cancel</button>
  `;
}

function renderKioskPinPad() {
  const dots = Array.from({ length: Math.max(4, state.kioskPinBuffer.length) }).map((_, i) =>
    `<span class="pin-dot ${i < state.kioskPinBuffer.length ? 'filled' : ''}"></span>`).join('');
  return `
    <div style="text-align:left;margin-top:14px;">
      <label>Your email</label>
      <input id="kioskEmailField" type="email" placeholder="you@email.com" value="${escapeHtml(state.kioskEmailInput)}" autocomplete="off"/>
    </div>
    <div style="display:flex;gap:10px;justify-content:center;margin:18px 0 6px;">${dots}</div>
    ${state.kioskError ? `<div style="color:var(--bad-soft);font-size:12.5px;margin-bottom:8px;">${escapeHtml(state.kioskErrorMessage || 'Incorrect email or PIN, try again.')}</div>` : '<div style="height:19px;"></div>'}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map(k => {
        if (k === '⌫') return `<button class="keypad-btn" id="kioskBack">⌫</button>`;
        if (k === '✓') return `<button class="keypad-btn enter" id="kioskEnter" ${state.kioskBusy ? 'disabled' : ''}>${state.kioskBusy ? '…' : '✓'}</button>`;
        return `<button class="keypad-btn kiosk-digit" data-d="${k}">${k}</button>`;
      }).join('')}
    </div>
  `;
}

function renderKioskResultBlock() {
  const labels = {
    clocked_in: '✓ Clocked in', clocked_out: '✓ Clocked out',
    started_break: '✓ Break started', started_lunch: '✓ Lunch started', ended_break: '✓ Back to work'
  };
  const exc = state.kioskResult.scheduleException;
  return `
    <div class="card fade-in" style="margin:16px 0;border-color:${exc ? 'var(--accent)' : 'var(--good)'};padding:18px;text-align:left;">
      <div class="font-display" style="font-size:18px;color:var(--good-soft);text-align:center;">${labels[state.kioskResult.action] || '✓ Done'}</div>
      <div style="font-size:14px;margin-top:6px;text-align:center;">${escapeHtml(state.kioskResult.userName)}</div>
      ${exc ? `
        <div style="margin-top:14px;padding-top:14px;border-top:1px dashed var(--border-soft);">
          <div style="font-size:12.5px;color:var(--accent-soft);font-weight:600;">${exc.type === 'no_shift' ? 'No shift scheduled today' : `${exc.minutes_late} min after your ${exc.scheduled_start} start`}</div>
          <div style="color:var(--text-faint);font-size:11.5px;margin-top:4px;">Add a quick reason for admin to review.</div>
          <input id="kioskReasonField" placeholder="e.g. Swapped shift with Juan" value="${escapeHtml(state.kioskReasonInput)}" style="margin-top:8px;"/>
          <div style="display:flex;gap:8px;margin-top:10px;">
            <button id="skipKioskReasonBtn" class="btn btn-ghost" style="flex:1;padding:9px;font-size:12.5px;">Skip</button>
            <button id="submitKioskReasonBtn" class="btn btn-accent" style="flex:1;padding:9px;font-size:12.5px;">Submit</button>
          </div>
        </div>` : ''}
    </div>
  `;
}

function renderKioskConfirmPanel() {
  const l = state.kioskLookup;
  const verb = KIOSK_ACTION_VERBS[state.kioskConfirmingAction] || 'do this';
  const dots = Array.from({ length: Math.max(4, state.kioskPinBuffer.length) }).map((_, i) =>
    `<span class="pin-dot ${i < state.kioskPinBuffer.length ? 'filled' : ''}"></span>`).join('');
  return `
    <div class="font-display" style="font-size:17px;margin:6px 0 4px;">Confirm it's you, ${escapeHtml(l.userName)}</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">Enter your own email and PIN to ${verb}. A coworker can't do this for you.</div>
    <div style="text-align:left;">
      <label>Your email</label>
      <input id="kioskConfirmEmailField" type="email" placeholder="you@email.com" value="${escapeHtml(state.kioskEmailInput)}" autocomplete="off"/>
    </div>
    <div style="display:flex;gap:10px;justify-content:center;margin:14px 0 6px;">${dots}</div>
    ${state.kioskError ? `<div style="color:var(--bad-soft);font-size:12.5px;margin-bottom:8px;">${escapeHtml(state.kioskErrorMessage || 'Incorrect or mismatched email/PIN.')}</div>` : '<div style="height:19px;"></div>'}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px;">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'].map(k => {
        if (k === '⌫') return `<button class="keypad-btn" id="kioskConfirmBack">⌫</button>`;
        if (k === '✓') return `<button class="keypad-btn enter" id="kioskConfirmEnter" ${state.kioskBusy ? 'disabled' : ''}>${state.kioskBusy ? '…' : '✓'}</button>`;
        return `<button class="keypad-btn kiosk-confirm-digit" data-d="${k}">${k}</button>`;
      }).join('')}
    </div>
    <button class="btn btn-ghost kiosk-confirm-cancel-btn" style="margin-top:14px;width:100%;">Cancel</button>
  `;
}

function renderKioskBody() {
  if (state.kioskResult) return renderKioskResultBlock();
  if (state.kioskConfirmingAction) return renderKioskConfirmPanel();
  if (state.kioskLookup) return renderKioskLookupPanel();
  return renderKioskPinPad();
}

function renderKiosk() {
  return `
  <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;">
    <div class="fade-in" style="width:100%;max-width:340px;text-align:center;">
      <img src="/api/branding/logo" alt="${escapeHtml(state.cafeName)}" style="width:64px;height:64px;border-radius:50%;border:2px solid var(--border-soft);"/>
      <div class="font-display" style="font-size:26px;color:var(--text);margin-top:14px;">Quick Clock In/Out</div>
      <div style="color:var(--text-faint);font-size:13.5px;margin-top:6px;">Enter your own PIN. No need to log anyone out first.</div>

      ${renderKioskBody()}

      <button id="closeKioskBtn" class="btn btn-ghost" style="margin-top:22px;padding:10px 18px;font-size:12.5px;">← Back to login</button>
    </div>
  </div>`;
}

function attachKioskHandlers() {
  document.querySelectorAll('.kiosk-digit').forEach(b => b.addEventListener('click', () => kioskPressDigit(b.getAttribute('data-d'))));
  document.getElementById('kioskBack')?.addEventListener('click', kioskBackspace);
  document.getElementById('kioskEmailField')?.addEventListener('input', e => { state.kioskEmailInput = e.target.value; });
  document.getElementById('kioskConfirmEmailField')?.addEventListener('input', e => { state.kioskEmailInput = e.target.value; });
  document.getElementById('kioskEnter')?.addEventListener('click', submitKioskLookup);
  document.querySelectorAll('.kiosk-action-btn').forEach(b => b.addEventListener('click', () => {
    const action = b.getAttribute('data-action');
    if (action === 'end_break') requestEndBreakConfirm();
    else performKioskAction(action);
  }));
  document.querySelector('.kiosk-cancel-btn')?.addEventListener('click', cancelKioskLookup);
  document.querySelectorAll('.kiosk-confirm-digit').forEach(b => b.addEventListener('click', () => kioskPressDigit(b.getAttribute('data-d'))));
  document.getElementById('kioskConfirmBack')?.addEventListener('click', kioskBackspace);
  document.getElementById('kioskConfirmEnter')?.addEventListener('click', confirmEndBreakAction);
  document.querySelector('.kiosk-confirm-cancel-btn')?.addEventListener('click', cancelEndBreakConfirm);
  document.getElementById('kioskReasonField')?.addEventListener('input', e => { state.kioskReasonInput = e.target.value; });
  document.getElementById('submitKioskReasonBtn')?.addEventListener('click', submitKioskExceptionReason);
  document.getElementById('skipKioskReasonBtn')?.addEventListener('click', skipKioskExceptionReason);
  document.getElementById('closeKioskBtn')?.addEventListener('click', () => {
    state.kioskMode = false;
    kioskReset();
    render();
  });
}

/* ============================= RENDER: SHELL ============================= */
function svgIcon(name) {
  const icons = {
    dashboard: '<path d="M3 11h8V3H3v8zm0 10h8v-8H3v8zm10 0h8V13h-8v8zm0-18v8h8V3h-8z"/>',
    add: '<path d="M12 4v16m8-8H4"/>',
    discard: '<path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6h16z"/>',
    count: '<path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
    reports: '<path d="M3 3v18h18M8 17V9m4 8V5m4 12v-6"/>',
    movers: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    admin: '<path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.6 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06A1.65 1.65 0 009 4.6a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>',
    register: '<path d="M2 9h20M6 9V5a2 2 0 012-2h8a2 2 0 012 2v4M4 9h16v10a2 2 0 01-2 2H6a2 2 0 01-2-2V9z"/><path d="M9 13h6"/>',
    kitchen: '<path d="M3 2v7c0 1 1 2 2 2s2-1 2-2V2M5 11v11M9 2v9c0 1.5-1.5 3-3 3M15 2c-1.5 0-3 3-3 6s1.5 5 3 5v9"/>',
    history: '<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 106 5.3L3 8"/><path d="M12 7v5l3 3"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    recipe: '<path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/><path d="M9 7h7M9 11h5"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
    schedule: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    hr: '<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    requests: '<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
    audit: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"/>',
    team: '<path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/>',
    payroll: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
    inventory: '<path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>',
    pos: '<path d="M2 9h20M6 9V5a2 2 0 012-2h8a2 2 0 012 2v4M4 9h16v10a2 2 0 01-2 2H6a2 2 0 01-2-2V9z"/>',
    time: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[name] || ''}</svg>`;
}

function tabsForApp(mode) {
  if (mode === 'admin') {
    const tabs = [['overview', 'Overview', 'dashboard']];
    if (iCan('manage_team')) tabs.push(['team', 'Team', 'team']);
    if (iCan('view_reports')) tabs.push(['audit', 'Audit Log', 'audit']);
    if (iCan('manage_settings')) tabs.push(['settings', 'Settings', 'admin']);
    return tabs;
  }
  if (mode === 'pos') {
    const tabs = [['register', 'Register', 'register'], ['kitchen', 'Kitchen', 'kitchen'], ['recipes', 'Recipes', 'recipe'], ['history', 'Sales', 'history']];
    if (iCanApprove()) tabs.push(['approvals', 'Approvals', 'requests']);
    if (iCan('view_reports')) tabs.push(['shifts', 'Shifts', 'payroll']);
    if (iCan('manage_menu')) tabs.push(['items', 'Menu', 'menu']);
    return tabs;
  }
  if (mode === 'time') {
    const tabs = [['clock', 'Clock', 'clock'], ['schedule', 'Schedule', 'schedule'], ['hr', 'Notices', 'hr'], ['requests', 'Requests', 'requests']];
    if (iCan('manage_team')) tabs.push(['team', 'Team', 'team']);
    if (iCan('view_payroll')) tabs.push(['payroll', 'Payroll', 'payroll']);
    if (iCan('view_reports')) tabs.push(['eval', 'Evaluate', 'reports']);
    return tabs;
  }
  const tabs = [
    ['dashboard', 'Today', 'dashboard'],
    ['add', 'Add', 'add'],
    ['discard', 'Discard', 'discard'],
    ['count', 'Count', 'count'],
    ['reports', 'Reports', 'reports'],
    ['movers', 'Movers', 'movers'],
  ];
  if (iCan('manage_inventory')) tabs.push(['admin', 'Admin', 'admin']);
  return tabs;
}

function renderShell() {
  const tabs = tabsForApp(state.appMode);
  const apps = [
    ['inventory', 'Inventory', 'inventory'],
    ['pos', 'POS', 'pos'],
    ['time', 'Time Clock', 'time'],
  ];
  if (state.user.role === 'admin' || (state.user.role === 'manager' && ['manage_team', 'view_reports', 'manage_settings'].some(iCan))) apps.push(['admin', 'Admin', 'admin']);

  return `
  <div style="min-height:100vh;display:flex;flex-direction:column;">
    <header style="border-bottom:1px solid var(--border-soft);padding:14px 18px;position:sticky;top:0;background:var(--bg);z-index:10;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div style="display:flex;align-items:center;gap:10px;">
          ${state.appMode === 'pos' ? `<img src="/api/branding/logo" alt="logo" style="width:34px;height:34px;border-radius:50%;flex-shrink:0;"/>` : ''}
          <div>
            <div class="font-mono" style="font-size:10px;letter-spacing:0.13em;color:var(--text-faint);text-transform:uppercase;">${escapeHtml(state.cafeName)}</div>
            <div class="font-display" style="font-size:19px;line-height:1.1;">${apps.find(a => a[0] === state.appMode)[1]}</div>
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:600;">${escapeHtml(state.user.name)}</div>
          <div style="display:flex;align-items:center;gap:8px;justify-content:flex-end;">
            <span class="badge ${state.user.role === 'admin' ? 'badge-accent' : 'badge-good'}">${state.user.role}</span>
            <button id="openInlineKioskBtn" title="Quick clock in/out for anyone" style="background:none;border:none;color:var(--accent-soft);font-size:16px;cursor:pointer;line-height:1;padding:2px;">⏱</button>
            <button id="logoutBtn" style="background:none;border:none;color:var(--text-faint);font-size:12px;cursor:pointer;text-decoration:underline;">log out</button>
          </div>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;">
        ${apps.map(([id, label, icon]) => `
          <button class="btn app-switch-btn ${state.appMode === id ? 'btn-accent' : 'btn-ghost'}" data-app="${id}" style="flex:1;padding:9px 10px;gap:6px;font-size:13px;">
            ${svgIcon(icon)}${label}
          </button>`).join('')}
      </div>
    </header>

    <main style="flex:1;padding:18px;max-width:900px;margin:0 auto;width:100%;padding-bottom:100px;">
      ${state.appMode === 'pos' ? renderOfflineBanner() : ''}
      ${state.appMode === 'pos' && !state.loadingTab ? renderShiftBar() : ''}
      ${state.loadingTab ? `<div style="text-align:center;padding:60px 0;color:var(--text-faint);" class="font-mono">loading…</div>` : renderTab()}
    </main>

    <nav style="position:fixed;bottom:0;left:0;right:0;background:var(--panel);border-top:1px solid var(--border-soft);display:flex;padding:6px 6px calc(6px + env(safe-area-inset-bottom));max-width:900px;margin:0 auto;width:100%;left:50%;transform:translateX(-50%);">
      ${tabs.map(([id, label, icon]) => `
        <div class="navbtn ${state.tab === id ? 'active' : ''}" data-tab="${id}">
          ${svgIcon(icon)}
          <span>${label}</span>
        </div>`).join('')}
    </nav>
    ${renderToast()}
    ${renderModal()}
    ${renderInlineKioskModal()}
    ${renderVerifyModal()}
    ${renderDiscountApprovalModal()}
  </div>`;
}

function renderToast() {
  if (!state.toast) return '';
  const colors = { accent: 'var(--accent)', good: 'var(--good)', bad: 'var(--bad)' };
  const fg = state.toast.kind === 'bad' ? '#FBEAE3' : '#1C1410';
  return `<div class="fade-in" style="position:fixed;bottom:78px;left:50%;transform:translateX(-50%);background:${colors[state.toast.kind]};color:${fg};padding:10px 18px;border-radius:100px;font-size:13.5px;font-weight:600;z-index:60;box-shadow:0 8px 24px rgba(0,0,0,0.35);white-space:nowrap;max-width:90vw;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(state.toast.msg)}</div>`;
}

function renderInlineKioskModal() {
  if (!state.showInlineKiosk) return '';
  return `
  <div class="modal-backdrop">
    <div class="card fade-in" style="max-width:340px;width:100%;text-align:center;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div class="font-display" style="font-size:18px;">Quick Clock In/Out</div>
        <button id="closeInlineKioskBtn" style="background:none;border:none;color:var(--text-faint);font-size:22px;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:10px;">Anyone can punch in, out, or on break here with their own PIN — this won't affect your session.</div>

      ${renderKioskBody()}
    </div>
  </div>`;
}

function renderModal() {
  if (!state.confirmModal) return '';
  const m = state.confirmModal;
  return `
  <div class="modal-backdrop">
    <div class="card fade-in" style="max-width:380px;width:100%;">
      <div class="font-display" style="font-size:19px;color:${m.danger ? 'var(--bad-soft)' : 'var(--text)'};">${escapeHtml(m.title)}</div>
      <div style="color:var(--text-dim);font-size:13.5px;margin-top:8px;line-height:1.5;">${m.body}</div>
      ${m.requireType ? `
        <div style="margin-top:14px;">
          <label>Type ${m.requireType} to confirm</label>
          <input id="modalTypeInput" value="${escapeHtml(state.resetTypeInput)}" placeholder="${m.requireType}"/>
        </div>` : ''}
      ${m.requireReason ? `
        <div style="margin-top:14px;">
          <label>Reason</label>
          <input id="modalReasonInput" value="${escapeHtml(state.reasonInput)}" placeholder="${m.reasonPlaceholder || 'Required'}"/>
        </div>` : ''}
      ${m.amountInput ? `
        <div style="margin-top:14px;">
          <label>Amount (max ${fmtMoney(m.maxAmount)})</label>
          <input id="modalAmountInput" type="number" min="0.01" max="${m.maxAmount}" step="0.01" value="${state.amountInput}"/>
        </div>` : ''}
      <div style="display:flex;gap:10px;margin-top:18px;">
        <button id="modalCancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
        <button id="modalConfirm" class="btn ${m.danger ? 'btn-bad' : 'btn-accent'}" style="flex:1;" ${(m.requireType && state.resetTypeInput !== m.requireType) || (m.requireReason && !state.reasonInput.trim()) ? 'disabled' : ''}>${m.confirmLabel}</button>
      </div>
    </div>
  </div>`;
}

/* ============================= TAB DISPATCH ============================= */
function renderTab() {
  if (state.appMode === 'admin') {
    switch (state.tab) {
      case 'overview': return renderAdminOverview();
      case 'team': return iCan('manage_team') ? renderAdminTeam() : '<div>Not authorized.</div>';
      case 'audit': return iCan('view_reports') ? renderAuditLog() : '<div>Not authorized.</div>';
      case 'settings': return iCan('manage_settings') ? renderAdminSettings() : '<div>Not authorized.</div>';
      default: return '';
    }
  }
  if (state.appMode === 'pos') {
    switch (state.tab) {
      case 'register': return renderPosRegister();
      case 'kitchen': return renderPosKitchen();
      case 'recipes': return renderPosRecipes();
      case 'history': return renderPosHistory();
      case 'shifts': return iCan('view_reports') ? renderShiftsHistory() : '<div>Not authorized.</div>';
      case 'approvals': return renderApprovals();
      case 'items': return iCan('manage_menu') ? renderPosItems() : '<div>Not authorized.</div>';
      default: return '';
    }
  }
  if (state.appMode === 'time') {
    switch (state.tab) {
      case 'clock': return renderTimeClock();
      case 'schedule': return renderSchedule();
      case 'hr': return renderHr();
      case 'requests': return renderRequests();
      case 'team': return iCan('manage_team') ? renderTimeTeam() : '<div>Not authorized.</div>';
      case 'payroll': return iCan('view_payroll') ? renderTimePayroll() : '<div>Not authorized.</div>';
      case 'eval': return iCan('view_reports') ? renderTimeEval() : '<div>Not authorized.</div>';
      default: return '';
    }
  }
  switch (state.tab) {
    case 'dashboard': return renderDashboard();
    case 'add': return renderAddForm();
    case 'discard': return renderDiscardForm();
    case 'count': return renderCount();
    case 'reports': return renderReports();
    case 'movers': return renderMovers();
    case 'admin': return iCan('manage_inventory') ? renderAdmin() : '<div>Not authorized.</div>';
    default: return '';
  }
}

/* ============================= DASHBOARD ============================= */
function renderDashboard() {
  if (state.products.length === 0) return emptyState('No products yet', 'Ask an admin to add products in the Admin tab before logging stock.', 'admin');
  if (!state.dayLedger) return '';

  const today = todayStr();
  const ledger = state.dayLedger.ledger || {};
  const entries = state.todayEntries || [];
  const addsToday = entries.filter(e => e.type === 'add').length;
  const discardsToday = entries.filter(e => e.type === 'discard').length;
  const countedToday = state.products.filter(p => ledger[p.id] && ledger[p.id].actual !== null).length;

  const lowStock = state.products.filter(p => {
    const l = ledger[p.id]; if (!l) return false;
    return p.reorder_level !== '' && p.reorder_level !== null && p.reorder_level !== undefined && l.closing <= Number(p.reorder_level);
  });

  return `
  <div class="fade-in">
    <div style="display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:16px;">
      <div class="font-display" style="font-size:24px;">${fmtDateLong(today)}</div>
      <div class="font-mono" style="font-size:11.5px;color:var(--text-faint);">${state.products.length} products tracked</div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;">
      ${statCard('Stock added', addsToday, 'good')}
      ${statCard('Stock discarded', discardsToday, 'bad')}
      ${statCard('Counted', countedToday + ' / ' + state.products.length, 'accent')}
      ${statCard('Low stock', lowStock.length, lowStock.length > 0 ? 'bad' : 'good')}
    </div>

    ${lowStock.length > 0 ? `
      <div class="card" style="border-color:rgba(181,72,42,0.4);margin-bottom:18px;">
        <div style="font-weight:600;color:var(--bad-soft);font-size:14px;margin-bottom:8px;">⚠ Low stock — reorder soon</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          ${lowStock.map(p => {
            const l = ledger[p.id];
            return `<div style="display:flex;justify-content:space-between;font-size:13.5px;">
              <span>${escapeHtml(p.name)}</span>
              <span class="font-mono" style="color:var(--bad-soft);">${l.closing} ${escapeHtml(p.unit)} left</span>
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div class="font-display" style="font-size:17px;">Current stock</div>
        <span class="tag">live</span>
      </div>
      <table class="ledger-table">
        <thead><tr><th>Product</th><th>Opening</th><th>Added</th><th>Discarded</th><th>Stock now</th></tr></thead>
        <tbody>
          ${state.products.map(p => {
            const l = ledger[p.id] || { opening: 0, added: 0, discarded: 0, closing: 0 };
            return `<tr>
              <td>${escapeHtml(p.name)}<div style="color:var(--text-faint);font-size:10.5px;">${escapeHtml(p.unit)}</div></td>
              <td>${l.opening}</td>
              <td style="color:var(--good-soft);">${l.added > 0 ? '+' + l.added : '0'}</td>
              <td style="color:var(--bad-soft);">${l.discarded > 0 ? '-' + l.discarded : '0'}</td>
              <td style="font-weight:700;">${l.closing}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>

    <div style="display:flex;gap:10px;margin-top:16px;">
      <button class="btn btn-good btn-block goto-tab" data-tab="add">+ Add stock</button>
      <button class="btn btn-bad btn-block goto-tab" data-tab="discard">− Discard stock</button>
    </div>
  </div>`;
}

function statCard(label, value, kind) {
  const colors = { good: 'var(--good-soft)', bad: 'var(--bad-soft)', accent: 'var(--accent-soft)' };
  return `<div class="card" style="padding:14px;">
    <div style="font-size:10.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-faint);">${label}</div>
    <div class="font-mono" style="font-size:24px;font-weight:700;color:${colors[kind]};margin-top:4px;">${value}</div>
  </div>`;
}

function emptyState(title, body, gotoTab) {
  return `<div class="card fade-in" style="text-align:center;padding:40px 20px;">
    <div class="font-display" style="font-size:19px;">${title}</div>
    <div style="color:var(--text-faint);font-size:13.5px;margin-top:8px;">${body}</div>
    ${gotoTab ? `<button class="btn btn-accent goto-tab" data-tab="${gotoTab}" style="margin-top:16px;">Go there</button>` : ''}
  </div>`;
}

/* ============================= ADD / DISCARD FORMS ============================= */
const COMMON_UNITS = ['pcs', 'kg', 'g', 'L', 'mL', 'pack', 'box', 'bag', 'bottle', 'can', 'dozen', 'oz', 'lb'];

function unitSelectHtml(currentUnit) {
  const unit = currentUnit || 'pcs';
  const isCustom = !COMMON_UNITS.includes(unit);
  return `
    <select id="pf-unit-select">
      ${COMMON_UNITS.map(u => `<option value="${u}" ${!isCustom && unit === u ? 'selected' : ''}>${u}</option>`).join('')}
      <option value="__custom__" ${isCustom ? 'selected' : ''}>Custom…</option>
    </select>
    <input id="pf-unit-custom" value="${isCustom ? escapeHtml(unit) : ''}" placeholder="e.g. sack, tray, jar" style="margin-top:8px;display:${isCustom ? 'block' : 'none'};"/>
  `;
}

function productOptions() {
  if (state.products.length === 0) return `<option value="">No products yet</option>`;
  return `<option value="">Select a product…</option>` + state.products.map(p =>
    `<option value="${p.id}" ${state.formProductId === p.id ? 'selected' : ''}>${escapeHtml(p.name)} (${escapeHtml(p.unit)})</option>`
  ).join('');
}

function barcodeScanHtml(prefix) {
  return `<div style="margin-bottom:14px;">
    <label>Scan barcode</label>
    <input id="${prefix}-barcode" class="barcode-scan-input" placeholder="Scan or type a barcode, then Enter" autocomplete="off"/>
  </div>`;
}

function renderAddForm() {
  if (state.products.length === 0) return emptyState('No products yet', 'Ask an admin to add products before logging stock.', 'admin');
  return `
  <div class="fade-in card" style="max-width:440px;margin:0 auto;">
    <div class="font-display" style="font-size:20px;color:var(--good-soft);">+ Add stock</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-top:4px;">Delivery received, restock, or correction.</div>
    ${barcodeScanHtml('af')}
    <div><label>Product</label><select id="af-product">${productOptions()}</select></div>
    <div style="margin-top:14px;"><label>Quantity</label><input id="af-qty" type="number" min="0" step="any" placeholder="0" value="${escapeHtml(state.formQty)}"/></div>
    <div style="margin-top:14px;"><label>Note (optional)</label><input id="af-reason" placeholder="e.g. Supplier delivery" value="${escapeHtml(state.formReason)}"/></div>
    <button id="af-submit" class="btn btn-good btn-block" style="margin-top:18px;">Log stock added</button>
  </div>`;
}

function renderDiscardForm() {
  if (state.products.length === 0) return emptyState('No products yet', 'Ask an admin to add products before logging stock.', 'admin');
  const reasons = ['Spoilage', 'Damaged', 'Expired', 'Wrong order', 'Staff use', 'Other'];
  return `
  <div class="fade-in card" style="max-width:440px;margin:0 auto;">
    <div class="font-display" style="font-size:20px;color:var(--bad-soft);">− Discard stock</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-top:4px;">Waste, spoilage, damage, or loss.</div>
    ${barcodeScanHtml('df')}
    <div><label>Product</label><select id="df-product">${productOptions()}</select></div>
    <div style="margin-top:14px;"><label>Quantity</label><input id="df-qty" type="number" min="0" step="any" placeholder="0" value="${escapeHtml(state.formQty)}"/></div>
    <div style="margin-top:14px;"><label>Reason</label>
      <select id="df-reason">
        <option value="">Select a reason…</option>
        ${reasons.map(r => `<option value="${r}" ${state.formReason === r ? 'selected' : ''}>${r}</option>`).join('')}
      </select>
    </div>
    <button id="df-submit" class="btn btn-bad btn-block" style="margin-top:18px;">Log stock discarded</button>
  </div>`;
}

/* ============================= COUNT ============================= */
function renderCount() {
  if (state.products.length === 0) return emptyState('No products yet', 'Ask an admin to add products before counting.', 'admin');
  if (!state.dayLedger) return '';
  const ledger = state.dayLedger.ledger || {};
  return `
  <div class="fade-in">
    <div class="font-display" style="font-size:20px;">Today's actual count</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-top:4px;margin-bottom:16px;">
      Physically count what's on the shelf. The system compares it to what the ledger expects and flags the difference.
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.products.map(p => {
        const l = ledger[p.id] || { systemStock: 0, actual: null, variance: null };
        const inputVal = state.countInputs[p.id] !== undefined ? state.countInputs[p.id] : (l.actual !== null ? l.actual : '');
        let varBadge = '';
        if (l.actual !== null) {
          if (l.variance === 0) varBadge = `<span class="badge badge-good">matches</span>`;
          else if (l.variance > 0) varBadge = `<span class="badge badge-accent">+${l.variance} over</span>`;
          else varBadge = `<span class="badge badge-bad">${l.variance} short</span>`;
        }
        return `<div class="card" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
          <div style="flex:1;min-width:140px;">
            <div style="font-weight:600;font-size:14.5px;">${escapeHtml(p.name)}</div>
            <div class="font-mono" style="font-size:11.5px;color:var(--text-faint);">expected ${l.systemStock} ${escapeHtml(p.unit)} ${varBadge}</div>
          </div>
          <input type="number" step="any" class="count-input" data-pid="${p.id}" value="${inputVal}" placeholder="count" style="width:100px;text-align:right;font-family:'IBM Plex Mono',monospace;"/>
          <button class="btn btn-accent count-save" data-pid="${p.id}" style="padding:9px 14px;">Save</button>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

/* ============================= REPORTS ============================= */
function renderReports() {
  const modes = [['daily', 'Daily'], ['comparison', 'Compare'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
  return `
  <div class="fade-in">
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      ${modes.map(([id, label]) => `<button class="btn ${state.reportMode === id ? 'btn-accent' : 'btn-ghost'} report-mode-btn" data-mode="${id}">${label}</button>`).join('')}
    </div>
    ${state.reportMode === 'daily' ? renderDailyReport() : state.reportMode === 'comparison' ? renderComparisonReport() : state.reportMode === 'monthly' ? renderMonthlyReport() : renderYearlyReport()}
  </div>`;
}

function renderDailyReport() {
  if (!state.dayLedger) return '';
  const date = state.reportDate;
  const ledger = state.dayLedger.ledger || {};
  const entries = state.todayEntries || [];
  return `
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
    <input type="date" id="dailyDatePick" value="${date}" max="${todayStr()}" style="max-width:180px;"/>
    <div class="font-display" style="font-size:15px;color:var(--text-dim);">${fmtDateLong(date)}</div>
  </div>
  <div class="card">
    <table class="ledger-table">
      <thead><tr><th>Product</th><th>Opening</th><th>Added</th><th>Discarded</th><th>System</th><th>Counted</th><th>Variance</th></tr></thead>
      <tbody>
        ${state.products.length === 0 ? `<tr><td colspan="7" style="text-align:center;color:var(--text-faint);">No products.</td></tr>` :
        state.products.map(p => {
          const l = ledger[p.id] || { opening: 0, added: 0, discarded: 0, systemStock: 0, actual: null, variance: null };
          return `<tr>
            <td>${escapeHtml(p.name)}</td>
            <td>${l.opening}</td>
            <td style="color:var(--good-soft);">${l.added > 0 ? '+' + l.added : '0'}</td>
            <td style="color:var(--bad-soft);">${l.discarded > 0 ? '-' + l.discarded : '0'}</td>
            <td>${l.systemStock}</td>
            <td>${l.actual !== null ? l.actual : '—'}</td>
            <td style="color:${l.variance > 0 ? 'var(--accent-soft)' : l.variance < 0 ? 'var(--bad-soft)' : 'var(--text-dim)'};">${l.variance !== null ? (l.variance > 0 ? '+' : '') + l.variance : '—'}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>
  <div class="font-display" style="font-size:16px;margin:18px 0 8px;">Movement log</div>
  <div class="card">
    ${entries.length === 0 ? `<div style="color:var(--text-faint);font-size:13px;">No entries logged this day.</div>` :
      entries.map(e => {
        const p = state.products.find(x => x.id === e.product_id);
        const typeColor = e.type === 'add' ? 'var(--good-soft)' : e.type === 'discard' ? 'var(--bad-soft)' : 'var(--accent-soft)';
        const typeLabel = e.type === 'add' ? '+ ADD' : e.type === 'discard' ? '− DISCARD' : '✓ COUNT';
        return `<div style="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px dashed var(--border-soft);font-size:13px;flex-wrap:wrap;">
          <div>
            <span class="font-mono" style="color:${typeColor};font-weight:700;font-size:11px;">${typeLabel}</span>
            <span style="margin-left:8px;">${escapeHtml(p ? p.name : '—')}</span>
            ${e.reason ? `<span style="color:var(--text-faint);"> · ${escapeHtml(e.reason)}</span>` : ''}
          </div>
          <div class="font-mono" style="color:var(--text-faint);">${e.qty} · ${escapeHtml(e.staff_name)} · ${fmtTime(e.created_at)}</div>
        </div>`;
      }).join('')}
  </div>`;
}

function renderComparisonReport() {
  if (!state.dayLedger) return '';
  const date = state.reportDate;
  const ledger = state.dayLedger.ledger || {};
  const prevDate = addDaysISO(date, -1);
  const compactDate = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  let totalAdded = 0, totalUsed = 0, totalYesterday = 0, totalToday = 0;
  state.products.forEach(p => {
    const l = ledger[p.id];
    if (!l) return;
    totalAdded += l.added;
    totalUsed += l.discarded;
    totalYesterday += l.opening;
    totalToday += l.closing;
  });
  const netChange = totalToday - totalYesterday;

  return `
  <div>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="comparisonDatePick" value="${date}" max="${todayStr()}" style="max-width:180px;"/>
      <div class="font-display" style="font-size:15px;color:var(--text-dim);">${compactDate(prevDate)} → ${compactDate(date)}</div>
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;">
      ${statCard('Added', totalAdded, 'good')}
      ${statCard('Used/discarded', totalUsed, 'bad')}
      ${statCard('Net change', (netChange > 0 ? '+' : '') + netChange, netChange >= 0 ? 'good' : 'bad')}
    </div>

    <div class="card">
      <table class="ledger-table">
        <thead><tr><th>Product</th><th>${compactDate(prevDate)}</th><th>Added</th><th>Used</th><th>${compactDate(date)}</th><th>Change</th></tr></thead>
        <tbody>
          ${state.products.length === 0 ? `<tr><td colspan="6" style="text-align:center;color:var(--text-faint);">No products.</td></tr>` :
          state.products.map(p => {
            const l = ledger[p.id] || { opening: 0, added: 0, discarded: 0, closing: 0 };
            const change = l.closing - l.opening;
            return `<tr>
              <td>${escapeHtml(p.name)}<div style="color:var(--text-faint);font-size:10.5px;">${escapeHtml(p.unit)}</div></td>
              <td>${l.opening}</td>
              <td style="color:var(--good-soft);">${l.added > 0 ? '+' + l.added : '0'}</td>
              <td style="color:var(--bad-soft);">${l.discarded > 0 ? '-' + l.discarded : '0'}</td>
              <td style="font-weight:700;">${l.closing}</td>
              <td style="color:${change > 0 ? 'var(--good-soft)' : change < 0 ? 'var(--bad-soft)' : 'var(--text-faint)'};">${change > 0 ? '↑ +' + change : change < 0 ? '↓ ' + change : '—'}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:10px;">Compares each product's remaining stock against the day before. "${compactDate(prevDate)}" is exactly what stock closed at the end of the previous day — the starting point for ${compactDate(date)}.</div>
  </div>`;
}

function renderMonthlyReport() {
  if (!state.monthLedger) return '';
  const { month, agg, daysInMonth } = state.monthLedger;
  return `
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
    <input type="month" id="monthlyPick" value="${month}" max="${monthStr(new Date())}" style="max-width:180px;"/>
    <div class="font-display" style="font-size:15px;color:var(--text-dim);">${fmtMonthLong(month)}</div>
  </div>
  <div class="card">
    <table class="ledger-table">
      <thead><tr><th>Product</th><th>Added</th><th>Discarded</th><th>Days counted</th><th>End of month stock</th></tr></thead>
      <tbody>
        ${state.products.length === 0 ? `<tr><td colspan="5" style="text-align:center;color:var(--text-faint);">No products.</td></tr>` :
        state.products.map(p => {
          const a = agg[p.id] || { added: 0, discarded: 0, daysCounted: 0, lastClosing: 0 };
          return `<tr>
            <td>${escapeHtml(p.name)}</td>
            <td style="color:var(--good-soft);">${a.added > 0 ? '+' + a.added : '0'}</td>
            <td style="color:var(--bad-soft);">${a.discarded > 0 ? '-' + a.discarded : '0'}</td>
            <td>${a.daysCounted} / ${daysInMonth}</td>
            <td style="font-weight:700;">${a.lastClosing}</td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>
  </div>`;
}

function renderYearlyReport() {
  if (!state.yearLedger) return '';
  const { year, perMonth } = state.yearLedger;
  const maxVal = Math.max(1, ...perMonth.map(x => Math.max(x.added, x.discarded)));
  return `
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
    <select id="yearPick" style="max-width:140px;">${yearOptions()}</select>
    <div class="font-display" style="font-size:15px;color:var(--text-dim);">${year} overview</div>
  </div>
  <div class="card">
    <div style="display:flex;gap:14px;margin-bottom:14px;font-size:12px;color:var(--text-faint);">
      <span><span style="display:inline-block;width:9px;height:9px;background:var(--good);border-radius:2px;margin-right:5px;"></span>added</span>
      <span><span style="display:inline-block;width:9px;height:9px;background:var(--bad);border-radius:2px;margin-right:5px;"></span>discarded</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${perMonth.map(x => {
        const mName = new Date(x.month + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' });
        return `<div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
            <span class="font-mono" style="color:var(--text-dim);">${mName}</span>
            <span class="font-mono" style="color:var(--text-faint);">${x.hasData ? `+${x.added} / -${x.discarded}` : '—'}</span>
          </div>
          <div style="display:flex;gap:3px;">
            <div class="bar-track" style="flex:1;"><div class="bar-fill" style="width:${(x.added / maxVal) * 100}%;background:var(--good);"></div></div>
            <div class="bar-track" style="flex:1;"><div class="bar-fill" style="width:${(x.discarded / maxVal) * 100}%;background:var(--bad);"></div></div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function yearOptions() {
  const current = new Date().getFullYear();
  const years = [current, current - 1, current - 2];
  return years.map(y => `<option value="${y}" ${Number(state.reportYear) === y ? 'selected' : ''}>${y}</option>`).join('');
}

/* ============================= FAST / SLOW MOVERS ============================= */
function renderMovers() {
  if (state.products.length === 0) return emptyState('No products yet', 'Add products first to analyze fast and slow movers.', 'admin');
  if (!state.moversData) return '';
  const { days, stats } = state.moversData;
  const maxTurnover = Math.max(1, ...stats.map(s => s.turnover));
  const fast = stats.slice().sort((a, b) => b.turnover - a.turnover).filter(s => s.turnover > 0).slice(0, 8);
  const slow = stats.slice().sort((a, b) => a.turnover - b.turnover).slice(0, 8);

  return `
  <div class="fade-in">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:16px;">
      <span style="font-size:13px;color:var(--text-faint);">Period:</span>
      ${[7, 30, 90].map(n => `<button class="btn ${state.moversPeriod === n ? 'btn-accent' : 'btn-ghost'} movers-period-btn" data-period="${n}" style="padding:7px 12px;">${n}d</button>`).join('')}
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="font-display" style="font-size:17px;color:var(--good-soft);">Fast moving</div>
      <div style="color:var(--text-faint);font-size:12px;margin-bottom:12px;">Highest stock turnover (added + discarded) in the last ${days} days.</div>
      ${fast.length === 0 ? `<div style="color:var(--text-faint);font-size:13px;">No movement recorded in this period.</div>` :
      fast.map(s => `
        <div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:3px;">
            <span>${escapeHtml(s.product.name)}</span>
            <span class="font-mono" style="color:var(--good-soft);">${s.turnover} ${escapeHtml(s.product.unit)}</span>
          </div>
          <div class="bar-track"><div class="bar-fill" style="width:${(s.turnover / maxTurnover) * 100}%;background:var(--good);"></div></div>
        </div>`).join('')}
    </div>

    <div class="card">
      <div class="font-display" style="font-size:17px;color:var(--bad-soft);">Slow moving</div>
      <div style="color:var(--text-faint);font-size:12px;margin-bottom:12px;">Lowest turnover — candidates for smaller reorders or menu review.</div>
      ${slow.map(s => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px dashed var(--border-soft);font-size:13px;">
          <div>
            <div>${escapeHtml(s.product.name)}</div>
            <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${s.turnover} ${escapeHtml(s.product.unit)} moved${s.daysIdle !== null ? ` · last moved ${s.daysIdle === 0 ? 'today' : s.daysIdle + 'd ago'}` : ' · no movement'}</div>
          </div>
          ${s.turnover === 0 ? `<span class="badge badge-bad">idle</span>` : ''}
        </div>`).join('')}
    </div>
  </div>`;
}

/* ============================= ADMIN ============================= */
function renderAdminOverview() {
  const o = state.overviewData;
  if (!o) return '';
  const graceMin = Number(state.settings.late_grace_minutes || 10);
  return `
  <div class="fade-in">
    <div class="font-display" style="font-size:20px;margin-bottom:14px;">${fmtDateLong(todayStr())} at a glance</div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div class="font-display" style="font-size:14px;color:var(--text-faint);">📌 Attention note <span style="color:var(--text-faint);font-weight:400;">(shown to staff on Clock)</span></div>
      ${!state.editingAttentionNote ? `<button id="editAttentionBtn" class="btn btn-ghost" style="padding:6px 12px;font-size:12px;">Edit</button>` : ''}
    </div>
    <div class="card" style="margin-bottom:20px;border-color:var(--accent);">
      ${state.editingAttentionNote ? `
        <textarea id="attentionNoteInput" rows="3" placeholder="e.g. Deep clean the espresso machine today. Inventory count at 5pm.">${escapeHtml(state.attentionNoteDraft)}</textarea>
        <div style="display:flex;gap:10px;margin-top:10px;">
          <button id="cancelAttentionBtn" class="btn btn-ghost" style="flex:1;">Cancel</button>
          <button id="saveAttentionBtn" class="btn btn-accent" style="flex:1;">Save</button>
        </div>
      ` : (state.settings.attention_note ? `<div style="font-size:13.5px;color:var(--text-dim);line-height:1.5;white-space:pre-wrap;">${escapeHtml(state.settings.attention_note)}</div>` : `<div style="color:var(--text-faint);font-size:13px;">Nothing posted — staff won't see an attention note today.</div>`)}
    </div>

    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
      <div class="font-display" style="font-size:14px;color:var(--text-faint);">Staff right now</div>
      <span class="tag">live</span>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
      ${!state.liveStatus || state.liveStatus.staff.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No active staff.</div>` :
      state.liveStatus.staff.map(s => renderStaffStatusRow(s, graceMin)).join('')}
    </div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin-bottom:8px;">Inventory</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px;">
      ${statCard('Stock added', o.addsToday, 'good')}
      ${statCard('Stock discarded', o.discardsToday, 'bad')}
      ${statCard('Low stock', o.lowStockCount, o.lowStockCount > 0 ? 'bad' : 'good')}
    </div>
    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin-bottom:8px;">POS</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:20px;">
      ${statCard('Gross sales', fmtMoney(o.salesTotal), 'good')}
      ${statCard('Transactions', o.salesCount, 'accent')}
    </div>
    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin-bottom:8px;">Time Clock</div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;">
      ${statCard('Clocked in now', o.clockedInCount, 'accent')}
      ${statCard('Attendance flags', o.attendanceIssues, o.attendanceIssues > 0 ? 'bad' : 'good')}
    </div>
  </div>`;
}

function isLateNow(shiftStart, graceMinutes) {
  const now = new Date();
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const [h, m] = shiftStart.split(':').map(Number);
  return nowMinutes > (h * 60 + m) + graceMinutes;
}

function elapsedLabel(sqliteUtc) {
  const mins = minutesAgo(sqliteUtc);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${pad(m)}m` : `${m}m`;
}

function renderRosterRow(s) {
  const cfg = {
    working: { label: 'Working', badge: 'badge-good' },
    break: { label: 'On break', badge: 'badge-accent' },
    lunch: { label: 'On lunch', badge: 'badge-accent' },
    off: { label: 'Off', badge: '' },
  }[s.status];

  let actions;
  if (s.status === 'off') actions = [['clock_in', 'Clock In']];
  else if (s.status === 'break' || s.status === 'lunch') actions = [['end_break', 'Back to Shift']];
  else actions = [['start_break', 'Break'], ['start_lunch', 'Lunch'], ['clock_out', 'Clock Out']];
  const breakType = s.status === 'lunch' ? 'lunch' : s.status === 'break' ? 'break' : null;

  return `
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-weight:600;">${escapeHtml(s.user.name)}</span>
            ${s.user.position ? `<span class="badge" style="font-size:10px;">${escapeHtml(s.user.position)}</span>` : ''}
          </div>
          ${s.status !== 'off' && s.since ? `<div class="font-mono" style="font-size:11px;color:var(--text-faint);">running ${elapsedLabel(s.since)}</div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
          <span class="badge ${cfg.badge}">${cfg.label}</span>
          ${s.exceptionToday && s.exceptionToday.status !== 'approved' ? `<span class="badge ${s.exceptionToday.status === 'denied' ? 'badge-bad' : 'badge-accent'}">⚠ ${s.exceptionToday.type === 'no_shift' ? 'No shift' : 'Late'}${s.exceptionToday.status === 'denied' ? ' · denied' : ''}</span>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
        ${actions.map(([action, label]) => `<button class="btn btn-ghost roster-action-btn" data-user-id="${s.user.id}" data-user-name="${escapeHtml(s.user.name)}" data-action="${action}" data-break-type="${breakType || ''}" style="padding:6px 12px;font-size:12px;flex:1;">${label}</button>`).join('')}
      </div>
    </div>`;
}

function renderStaffStatusRow(s, graceMin) {
  const cfg = {
    working: { label: 'Working', badge: 'badge-good' },
    break: { label: 'On break', badge: 'badge-accent' },
    lunch: { label: 'On lunch', badge: 'badge-accent' },
    off: { label: 'Off', badge: '' },
  }[s.status];
  const late = s.status === 'off' && !s.hasClockedInToday && s.shiftToday && isLateNow(s.shiftToday.start_time, graceMin);
  const sinceLabel = s.since ? (s.status === 'working' ? 'since ' + fmtTime(s.since) : 'since ' + fmtTime(s.since)) : '';
  return `
    <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div>
        <div style="font-weight:600;">${escapeHtml(s.user.name)}</div>
        <div class="font-mono" style="font-size:11px;color:var(--text-faint);">
          ${s.shiftToday ? `scheduled ${s.shiftToday.start_time}\u2013${s.shiftToday.end_time}` : 'no shift scheduled today'}
        </div>
      </div>
      <div style="text-align:right;">
        <span class="badge ${late ? 'badge-bad' : cfg.badge}">${late ? 'Late' : cfg.label}</span>
        ${sinceLabel && !late ? `<div class="font-mono" style="font-size:10.5px;color:var(--text-faint);margin-top:3px;">${sinceLabel}</div>` : ''}
      </div>
    </div>`;
}

/* ============================= AUDIT LOG ============================= */
function auditActionLabel(action) {
  return {
    void_sale: 'Sale voided',
    refund_sale: 'Sale refunded',
    update_settings: 'Settings changed',
    reset_today_inventory: "Cleared today's inventory",
    reset_all_inventory: 'Reset all inventory data',
    download_backup: 'Backup downloaded',
    export_excel: 'Excel export downloaded',
    update_logo: 'Logo updated',
    update_recipe_image: 'Recipe photo updated',
    reset_logo: 'Logo reset to default',
    create_product: 'Product added',
    edit_product: 'Product edited',
    delete_product: 'Product removed',
    create_menu_item: 'Menu item added',
    edit_menu_item: 'Menu item edited',
    delete_menu_item: 'Menu item removed',
    create_user: 'Team member added',
    edit_user: 'Team member edited',
    delete_user: 'Team member removed',
    deactivate_user: 'Team member deactivated',
    edit_entry: 'Ledger entry edited',
    delete_entry: 'Ledger entry deleted',
    create_shift: 'Shift scheduled',
    edit_shift: 'Shift edited',
    delete_shift: 'Shift removed',
    create_policy: 'Policy added',
    edit_policy: 'Policy edited',
    delete_policy: 'Policy removed',
    create_notice: 'Notice sent',
    delete_notice: 'Notice deleted',
    edit_time_entry: 'Time punch edited',
    delete_time_entry: 'Time punch deleted',
    create_attendance_mark: 'Attendance marked',
    edit_attendance_mark: 'Attendance mark edited',
    delete_attendance_mark: 'Attendance mark removed',
  }[action] || action;
}
function auditActionBadgeClass(action) {
  if (action === 'void_sale' || action === 'refund_sale' || action.startsWith('reset_') || action.startsWith('delete_')) return 'badge-bad';
  if (action === 'update_settings' || action === 'download_backup' || action.startsWith('edit_') || action === 'deactivate_user') return 'badge-accent';
  return '';
}

function renderAuditLog() {
  const actions = [
    '', 'void_sale', 'refund_sale', 'update_settings', 'reset_today_inventory', 'reset_all_inventory', 'download_backup', 'export_excel',
    'update_logo', 'reset_logo', 'update_recipe_image',
    'create_product', 'edit_product', 'delete_product',
    'create_menu_item', 'edit_menu_item', 'delete_menu_item',
    'create_user', 'edit_user', 'delete_user', 'deactivate_user',
    'edit_entry', 'delete_entry',
    'create_shift', 'edit_shift', 'delete_shift',
    'create_policy', 'edit_policy', 'delete_policy',
    'create_notice', 'delete_notice',
    'edit_time_entry', 'delete_time_entry',
    'create_attendance_mark', 'edit_attendance_mark', 'delete_attendance_mark',
  ];
  return `
  <div class="fade-in">
    <div class="font-display" style="font-size:20px;margin-bottom:6px;">Audit log</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">An append-only record of voids, refunds, setting changes, and data resets — nothing here can be edited or deleted.</div>
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;align-items:center;">
      <input type="date" id="auditStartPick" value="${state.auditStart}" max="${todayStr()}" style="max-width:160px;"/>
      <span style="color:var(--text-faint);">to</span>
      <input type="date" id="auditEndPick" value="${state.auditEnd}" max="${todayStr()}" style="max-width:160px;"/>
      <select id="auditActionFilter" style="max-width:200px;">
        ${actions.map(a => `<option value="${a}" ${state.auditFilterAction === a ? 'selected' : ''}>${a ? auditActionLabel(a) : 'All actions'}</option>`).join('')}
      </select>
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.auditLogEntries.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No activity in this range.</div>` :
      state.auditLogEntries.map(e => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <span class="badge ${auditActionBadgeClass(e.action)}">${auditActionLabel(e.action)}</span>
            <span class="font-mono" style="font-size:11px;color:var(--text-faint);">${fmtDateTimeShort(e.created_at)}</span>
          </div>
          <div style="font-size:13px;margin-top:8px;">by ${escapeHtml(e.user_name || 'Unknown')}</div>
          ${e.details ? `<div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:6px;white-space:pre-wrap;">${escapeHtml(JSON.stringify(e.details, null, 2))}</div>` : ''}
        </div>`).join('')}
    </div>
  </div>`;
}

function renderAdmin() {
  const sections = [['products', 'Products'], ['log', 'Entry log'], ['danger', 'Reset']];
  return `
  <div class="fade-in">
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      ${sections.map(([id, label]) => `<button class="btn ${state.adminSection === id ? 'btn-accent' : 'btn-ghost'} admin-sec-btn" data-sec="${id}">${label}</button>`).join('')}
    </div>
    ${state.adminSection === 'products' ? renderAdminProducts() :
      state.adminSection === 'log' ? renderAdminLog() :
      renderAdminDanger()}
  </div>`;
}

function renderAdminProducts() {
  return `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <div class="font-display" style="font-size:17px;">Products</div>
    <button id="newProductBtn" class="btn btn-accent" style="padding:8px 14px;">+ New</button>
  </div>
  ${state.editProduct ? renderProductForm() : ''}
  <div style="display:flex;flex-direction:column;gap:8px;">
    ${state.products.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No products yet. Add your first one.</div>` :
    state.products.map(p => `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">${escapeHtml(p.name)}</div>
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(p.category || '—')} · unit: ${escapeHtml(p.unit)} · reorder at ${p.reorder_level !== '' && p.reorder_level !== null ? p.reorder_level : '—'} · start ${p.initial_stock || 0}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost edit-product-btn" data-id="${p.id}" style="padding:6px 12px;font-size:13px;">Edit</button>
          <button class="btn btn-ghost del-product-btn" data-id="${p.id}" style="padding:6px 12px;font-size:13px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
        </div>
      </div>`).join('')}
  </div>`;
}

function renderProductForm() {
  const p = state.editProduct;
  const isNew = !p._existing;
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">${isNew ? 'New product' : 'Edit product'}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div style="grid-column:1/-1;"><label>Name</label><input id="pf-name" value="${escapeHtml(p.name)}"/></div>
      <div><label>Category</label><input id="pf-category" value="${escapeHtml(p.category || '')}" placeholder="e.g. Beans"/></div>
      <div><label>Unit</label>
        ${unitSelectHtml(p.unit)}
      </div>
      <div><label>Starting stock</label><input id="pf-initial" type="number" step="any" value="${p.initial_stock != null ? p.initial_stock : 0}"/></div>
      <div><label>Reorder level (optional)</label><input id="pf-reorder" type="number" step="any" value="${p.reorder_level != null ? p.reorder_level : ''}" placeholder="alert below this"/></div>
      <div style="grid-column:1/-1;"><label>Barcode (optional)</label><input id="pf-barcode" value="${escapeHtml(p.barcode || '')}" placeholder="scan or type"/></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="pf-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="pf-save" class="btn btn-accent" style="flex:1;">Save product</button>
    </div>
  </div>`;
}

function renderAdminTeam() {
  let list = state.users.slice();
  if (state.teamFilterRole) list = list.filter(u => u.role === state.teamFilterRole);
  if (state.teamFilterStatus) list = list.filter(u => (state.teamFilterStatus === 'active') === !!u.active);
  if (state.teamSortBy === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
  else if (state.teamSortBy === 'role') list.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  else if (state.teamSortBy === 'active') list.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));

  return `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px;">
    <div class="font-display" style="font-size:17px;">Team</div>
    <button id="newUserBtn" class="btn btn-accent" style="padding:8px 14px;">+ New</button>
  </div>
  <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center;">
    <select id="teamSortSelect" style="max-width:170px;">
      <option value="name" ${state.teamSortBy === 'name' ? 'selected' : ''}>Sort: A–Z</option>
      <option value="role" ${state.teamSortBy === 'role' ? 'selected' : ''}>Sort: Role</option>
      <option value="active" ${state.teamSortBy === 'active' ? 'selected' : ''}>Sort: Active first</option>
    </select>
    <select id="teamRoleFilter" style="max-width:150px;">
      <option value="" ${!state.teamFilterRole ? 'selected' : ''}>All roles</option>
      <option value="admin" ${state.teamFilterRole === 'admin' ? 'selected' : ''}>Admin only</option>
      <option value="staff" ${state.teamFilterRole === 'staff' ? 'selected' : ''}>Staff only</option>
    </select>
    <select id="teamStatusFilter" style="max-width:150px;">
      <option value="" ${!state.teamFilterStatus ? 'selected' : ''}>All statuses</option>
      <option value="active" ${state.teamFilterStatus === 'active' ? 'selected' : ''}>Active only</option>
      <option value="inactive" ${state.teamFilterStatus === 'inactive' ? 'selected' : ''}>Inactive only</option>
    </select>
  </div>
  ${state.editUser ? renderUserForm() : ''}
  <div style="display:flex;flex-direction:column;gap:8px;">
    ${list.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">${state.users.length === 0 ? 'No team members yet.' : 'No one matches this filter.'}</div>` :
    list.map(u => `
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;">${escapeHtml(u.name)} ${u.active ? '' : '<span class="badge badge-bad" style="margin-left:6px;">inactive</span>'}</div>
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${u.role}${u.position ? ' · ' + escapeHtml(u.position) : ''}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="btn btn-ghost toggle-active-btn" data-id="${u.id}" data-active="${u.active ? '0' : '1'}" style="padding:6px 12px;font-size:13px;">${u.active ? 'Mark inactive' : 'Mark active'}</button>
          <button class="btn btn-ghost edit-user-btn" data-id="${u.id}" style="padding:6px 12px;font-size:13px;">Edit</button>
          <button class="btn btn-ghost del-user-btn" data-id="${u.id}" style="padding:6px 12px;font-size:13px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
        </div>
      </div>`).join('')}
  </div>`;
}

function renderUserForm() {
  const u = state.editUser;
  const isNew = !u._existing;
  const hrFieldDefs = [
    ['uf-address', 'address', 'Current address', 'text'],
    ['uf-contact', 'contact_number', 'Contact number', 'text'],
    ['uf-emergency', 'emergency_contact', 'Emergency contact number', 'text'],
    ['uf-dob', 'date_of_birth', 'Date of birth', 'date'],
    ['uf-tin', 'tin', 'TIN', 'text'],
    ['uf-sss', 'sss_number', 'SSS number', 'text'],
    ['uf-philhealth', 'philhealth_number', 'PhilHealth number', 'text'],
    ['uf-pagibig', 'pagibig_number', 'Pag-IBIG number', 'text'],
    ['uf-education', 'education', 'Educational background', 'text'],
    ['uf-datehired', 'date_hired', 'Date hired', 'date'],
    ['uf-termdate', 'termination_date', 'Termination date', 'date'],
  ];
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">${isNew ? 'New team member' : 'Edit team member'}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div style="grid-column:1/-1;"><label>Name</label><input id="uf-name" value="${escapeHtml(u.name)}"/></div>
      <div><label>Role</label>
        <select id="uf-role">
          <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option>
          <option value="team_lead" ${u.role === 'team_lead' ? 'selected' : ''}>Team Lead</option>
          ${state.user.role === 'admin' ? `
            <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>Manager</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
          ` : ''}
        </select>
      </div>
      <div><label>${isNew ? 'PIN' : 'New PIN (leave blank to keep current)'}</label><input id="uf-pin" type="text" inputmode="numeric" placeholder="4–8 digits"/></div>
      <div><label>Hourly rate (₱)</label><input id="uf-rate" type="number" min="0" step="0.01" value="${u.hourly_rate != null ? u.hourly_rate : 0}"/></div>
      <div><label>Email (required for Clock In/Out kiosk)</label><input id="uf-email" type="email" placeholder="you@email.com" value="${escapeHtml(u.email || '')}"/></div>
      <div><label>Position</label>
        <select id="uf-position">
          <option value="" ${!u.position ? 'selected' : ''}>—</option>
          ${['Cashier', 'Kitchen', 'Manager', 'Team Lead', 'Dining'].map(p => `<option value="${p}" ${u.position === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select>
      </div>
      ${!isNew ? `<div style="grid-column:1/-1;"><label>Status</label>
        <select id="uf-active">
          <option value="1" ${u.active ? 'selected' : ''}>Active</option>
          <option value="0" ${!u.active ? 'selected' : ''}>Inactive</option>
        </select>
      </div>` : ''}
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:10px;">Hourly rate is used for Time Clock payroll — leave at 0 if you're not tracking pay for this person. Email is also used to send notices and attachments, and is now <b>required</b> for this person to clock in/out or take breaks from the shared roster.</div>

    ${u.role === 'manager' ? `
      <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">What this Manager can access</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${state.permissionDefs.map(p => `
          <label style="display:flex;align-items:center;gap:10px;font-size:13px;cursor:pointer;">
            <input type="checkbox" class="uf-permission-check" data-key="${p.key}" ${u.manager_permissions_obj && u.manager_permissions_obj[p.key] ? 'checked' : ''} style="width:16px;height:16px;flex-shrink:0;"/>
            <span>${escapeHtml(p.label)}</span>
          </label>`).join('')}
      </div>
      <div style="color:var(--text-faint);font-size:11px;margin-top:8px;">Only these boxes decide what this Manager can do — nothing is granted automatically by the "Manager" title alone.</div>
    ` : ''}

    <button id="toggleHrDetailsBtn" class="btn btn-ghost btn-block" style="margin-top:16px;">${state.showHrDetails ? 'Hide' : 'Show'} HR details</button>
    ${state.showHrDetails ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;">
        ${hrFieldDefs.map(([id, field, label, type]) => `<div><label>${label}</label><input id="${id}" type="${type}" value="${escapeHtml(u[field] || '')}"/></div>`).join('')}
        <div style="grid-column:1/-1;"><label>Notes (for other comments about this staff member)</label><textarea id="uf-hrnotes" rows="3">${escapeHtml(u.hr_notes || '')}</textarea></div>
      </div>
      ${!isNew ? renderStaffDocumentsSection(u.id) : `<div style="color:var(--text-faint);font-size:11.5px;margin-top:12px;">Save this person first, then come back here to attach ID photo and clearance documents.</div>`}
    ` : ''}

    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="uf-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="uf-save" class="btn btn-accent" style="flex:1;">Save</button>
    </div>
  </div>`;
}

function renderStaffDocumentsSection(userId) {
  const DOC_TYPES = [['photo', 'Employee photo'], ['nbi', 'NBI clearance'], ['police', 'Police clearance'], ['barangay', 'Barangay clearance']];
  const docs = state.staffDocuments || {};
  return `
    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Documents</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${DOC_TYPES.map(([type, label]) => {
        const doc = docs[type];
        return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 0;border-bottom:1px dashed var(--border-soft);">
          <div>
            <div style="font-size:13px;font-weight:600;">${label}</div>
            <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${doc ? 'On file · ' + escapeHtml(doc.original_filename) : 'Not uploaded'}</div>
          </div>
          <div style="display:flex;gap:6px;align-items:center;">
            <input type="file" class="staff-doc-file" data-type="${type}" data-user="${userId}" accept="image/*,application/pdf" style="max-width:150px;font-size:11px;"/>
            <button class="btn btn-ghost staff-doc-upload-btn" data-type="${type}" data-user="${userId}" style="padding:6px 10px;font-size:11.5px;">Upload</button>
            ${doc ? `<button class="btn btn-ghost staff-doc-view-btn" data-type="${type}" data-user="${userId}" style="padding:6px 10px;font-size:11.5px;">View</button>
            <button class="btn btn-ghost staff-doc-remove-btn" data-type="${type}" data-user="${userId}" style="padding:6px 10px;font-size:11.5px;color:var(--bad-soft);">Remove</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>
    <div style="color:var(--text-faint);font-size:11px;margin-top:8px;">These are only visible to admin — not staff, not public.</div>`;
}

function renderAdminLog() {
  const entries = state.todayEntries || [];
  return `
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
    <input type="date" id="logDatePick" value="${state.editDate}" max="${todayStr()}" style="max-width:180px;"/>
    <div class="font-display" style="font-size:15px;color:var(--text-dim);">${fmtDateLong(state.editDate)}</div>
  </div>
  <div style="display:flex;flex-direction:column;gap:8px;">
    ${entries.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No entries this day.</div>` :
    entries.map(e => {
      const p = state.products.find(x => x.id === e.product_id);
      const typeColor = e.type === 'add' ? 'var(--good-soft)' : e.type === 'discard' ? 'var(--bad-soft)' : 'var(--accent-soft)';
      const typeLabel = e.type === 'add' ? 'ADD' : e.type === 'discard' ? 'DISCARD' : 'COUNT';
      return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <span class="font-mono" style="color:${typeColor};font-size:11px;font-weight:700;">${typeLabel}</span>
          <span style="margin-left:8px;font-weight:600;">${escapeHtml(p ? p.name : '—')}</span>
          ${e.reason ? `<span style="color:var(--text-faint);font-size:12.5px;"> · ${escapeHtml(e.reason)}</span>` : ''}
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:3px;">${escapeHtml(e.staff_name)} · ${fmtTime(e.created_at)}${e.edited_by ? ` · edited by ${escapeHtml(e.edited_by)}` : ''}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <input type="number" step="any" class="log-qty-edit" data-id="${e.id}" value="${e.qty}" style="width:80px;text-align:right;font-family:'IBM Plex Mono',monospace;"/>
          <button class="btn btn-ghost log-qty-save" data-id="${e.id}" style="padding:6px 10px;font-size:12.5px;">Save</button>
          <button class="btn btn-ghost log-del" data-id="${e.id}" style="padding:6px 10px;font-size:12.5px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderAdminSettings() {
  const s = state.settings || {};
  return `
  <div class="card" style="max-width:440px;">
    <div class="font-display" style="font-size:17px;margin-bottom:14px;">Settings</div>
    <label>Cafe name</label>
    <input id="set-cafename" value="${escapeHtml(s.cafe_name || '')}"/>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Shown in the header, login screen, and Time Clock notices.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Store logo</div>
    <div style="display:flex;align-items:center;gap:14px;">
      <img src="/api/branding/logo?t=${Date.now()}" alt="Current logo" style="width:64px;height:64px;border-radius:50%;border:1px solid var(--border-soft);object-fit:cover;"/>
      <div style="flex:1;">
        <input id="set-logo-file" type="file" accept="image/*"/>
        <div style="display:flex;gap:8px;margin-top:8px;">
          <button id="uploadLogoBtn" class="btn btn-accent" style="padding:8px 14px;font-size:12.5px;">Upload</button>
          <button id="resetLogoBtn" class="btn btn-ghost" style="padding:8px 14px;font-size:12.5px;">Reset to default</button>
        </div>
      </div>
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Shows on the login screen, POS, and every printed receipt. Square images work best.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Theme</div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
      ${[
        ['dark', 'Dark', '#1C1410', '#C98A2C'],
        ['light', 'Light', '#FAF7F2', '#B5772A'],
        ['dark-green', 'Dark Green', '#0F1A12', '#7FB069'],
        ['khaki', 'Khaki', '#1E1B14', '#BCA268'],
        ['dark-pink', 'Dark Pink', '#1D1017', '#D9679B'],
        ['dark-blue', 'Dark Blue', '#0D131E', '#5B8FD9'],
      ].map(([id, label, bgSwatch, accentSwatch]) => `
        <button class="btn ${(s.theme || 'dark') === id ? 'btn-accent' : 'btn-ghost'} theme-select-btn" data-theme="${id}" style="flex-direction:column;padding:10px;gap:6px;">
          <span style="display:flex;width:100%;height:22px;border-radius:5px;overflow:hidden;border:1px solid rgba(255,255,255,0.15);">
            <span style="flex:2;background:${bgSwatch};"></span>
            <span style="flex:1;background:${accentSwatch};"></span>
          </span>
          <span style="font-size:11.5px;">${label}</span>
        </button>`).join('')}
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Applies for everyone using this app — staff, POS, and the login screen. Pick one that matches your brand.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Time Clock</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div><label>Break limit (min)</label><input id="set-breaklimit" type="number" min="1" value="${s.break_limit_minutes != null ? s.break_limit_minutes : 15}"/></div>
      <div><label>Lunch limit (min)</label><input id="set-lunchlimit" type="number" min="1" value="${s.lunch_limit_minutes != null ? s.lunch_limit_minutes : 60}"/></div>
      <div style="grid-column:1/-1;"><label>Late grace period (min)</label><input id="set-lategrace" type="number" min="0" value="${s.late_grace_minutes != null ? s.late_grace_minutes : 10}"/></div>
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">A staff member is flagged "late" on the dashboard once this many minutes pass their scheduled start time with no clock-in.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Notices &amp; Email</div>
    <label>Reply-to email for notices</label>
    <input id="set-replyto" type="email" placeholder="e.g. vidalvhong@gmail.com" value="${escapeHtml(s.notice_reply_to || '')}"/>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">When staff reply to an emailed notice, their reply goes here — not tracked in the app, just a normal email reply landing in this inbox.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Business info (for receipts &amp; BIR records)</div>
    <label>Registered business name</label>
    <input id="set-bizname" placeholder="Legal/registered name" value="${escapeHtml(s.business_name || '')}"/>
    <div style="margin-top:12px;"><label>Business address</label><input id="set-bizaddress" placeholder="Full registered address" value="${escapeHtml(s.business_address || '')}"/></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
      <div><label>TIN</label><input id="set-biztin" placeholder="000-000-000-000" value="${escapeHtml(s.business_tin || '')}"/></div>
      <div><label>VAT status</label>
        <select id="set-vatstatus">
          <option value="yes" ${s.vat_registered !== 'no' ? 'selected' : ''}>VAT-registered</option>
          <option value="no" ${s.vat_registered === 'no' ? 'selected' : ''}>Non-VAT</option>
        </select>
      </div>
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">These print on every receipt. Filing your POS with the BIR (Permit to Use / CAS registration) is a separate step you handle with your RDO — this just gets the receipt format and record-keeping ready for it.</div>

    <div style="margin-top:12px;"><label>Invoice number prefix</label><input id="set-invprefix" placeholder="e.g. OR or AHC-7890" value="${escapeHtml(s.invoice_prefix || 'OR')}"/></div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Every receipt gets a sequential number like <span class="font-mono">${escapeHtml(s.invoice_prefix || 'OR')}-000001</span>. Some businesses include digits from their TIN here to make each series uniquely theirs — entirely up to you.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Receipt footer</div>
    <label>Facebook page</label>
    <input id="set-fbpage" placeholder="facebook.com/yourpage" value="${escapeHtml(s.facebook_page || '')}"/>
    <div style="margin-top:12px;"><label>Footer note / quote</label><textarea id="set-footernote" rows="2" placeholder="e.g. Follow us for new art nights and coffee specials!">${escapeHtml(s.receipt_footer_note || '')}</textarea></div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Printed at the bottom of every receipt, under "Thank you."</div>
    <button id="previewReceiptBtn" class="btn btn-ghost btn-block" style="margin-top:12px;">👁 Preview receipt with these settings</button>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:6px;">Shows a sample receipt using whatever's currently typed above — even before you save — so nothing's a surprise once real orders start printing.</div>

    <button id="set-save" class="btn btn-accent btn-block" style="margin-top:18px;">Save settings</button>
    <div style="color:var(--text-faint);font-size:12px;margin-top:14px;">PINs are now managed per person under the Team tab, not shared codes.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:22px 0 10px;">Backup</div>
    <a id="downloadBackupBtn" href="#" class="btn btn-ghost btn-block">⬇ Download full database backup</a>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Downloads the entire database as a single file — every sale, invoice number, product, and staff record. Worth doing regularly and storing somewhere safe.</div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 10px;">Export to spreadsheet</div>
    <a id="downloadExcelBtn" href="#" class="btn btn-ghost btn-block">📊 Download data as Excel</a>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">A spreadsheet with a tab each for Inventory Ledger, Products, Sales, Time Entries, Team, and Menu Items — opens directly in Excel or Google Sheets (upload it, or File → Import in Sheets).</div>
  </div>`;
}

function renderAdminDanger() {
  return `
  <div class="card" style="border-color:rgba(181,72,42,0.4);max-width:480px;">
    <div class="font-display" style="font-size:17px;color:var(--bad-soft);">Danger zone</div>
    <div style="color:var(--text-dim);font-size:13px;margin-top:6px;line-height:1.5;">
      These actions cannot be undone. Products and team accounts stay — only movement entries are cleared.
    </div>
    <div style="margin-top:18px;display:flex;flex-direction:column;gap:10px;">
      <button id="resetTodayBtn" class="btn btn-ghost" style="border-color:var(--bad);color:var(--bad-soft);">Clear today's entries</button>
      <button id="resetAllBtn" class="btn btn-bad">Reset all inventory data</button>
    </div>
  </div>`;
}

/* ============================= POS: REGISTER ============================= */
function renderDevicesButton() {
  return `<button id="devicesBtn" class="btn btn-ghost" style="padding:8px 12px;font-size:12.5px;">🔌 Devices${state.btPrinterConnected || state.btScannerConnected ? ` (${[state.btPrinterConnected && 'printer', state.btScannerConnected && 'scanner'].filter(Boolean).join(', ')})` : ''}</button>`;
}

function renderDevicesPanel() {
  const supported = bluetoothSupported();
  return `
  <div class="card fade-in" style="margin-bottom:14px;border-color:var(--accent);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <div class="font-display" style="font-size:16px;">Bluetooth devices</div>
      <button id="closeDevicesBtn" style="background:none;border:none;color:var(--text-faint);font-size:20px;cursor:pointer;line-height:1;">×</button>
    </div>
    ${!supported ? `<div class="badge badge-bad" style="margin-bottom:10px;">Bluetooth isn't available in this browser. Use Chrome on Android or Desktop — this doesn't work in Safari/iOS.</div>` : ''}

    <div style="padding:12px 0;border-bottom:1px dashed var(--border-soft);">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:600;font-size:13.5px;">Receipt printer</div>
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:2px;">${state.btPrinterConnected ? escapeHtml(state.btPrinterName) : 'Not connected'}</div>
        </div>
        <button class="btn ${state.btPrinterConnected ? 'btn-ghost' : 'btn-accent'}" id="${state.btPrinterConnected ? 'disconnectPrinterBtn' : 'connectPrinterBtn'}" style="padding:7px 14px;font-size:12.5px;" ${!supported ? 'disabled' : ''}>${state.btPrinterConnected ? 'Disconnect' : 'Connect'}</button>
      </div>
      <div style="color:var(--text-faint);font-size:11px;margin-top:8px;">Only works with printers that support Bluetooth Low Energy — many receipt printers use a different Bluetooth mode this can't reach. If connecting doesn't find your printer, use the regular "Print receipt" button instead, which works with any printer set up on this device.</div>
    </div>

    <div style="padding:12px 0;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-weight:600;font-size:13.5px;">Barcode scanner</div>
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:2px;">${state.btScannerConnected ? escapeHtml(state.btScannerName) : 'Not connected'}</div>
        </div>
        <button class="btn ${state.btScannerConnected ? 'btn-ghost' : 'btn-accent'}" id="${state.btScannerConnected ? 'disconnectScannerBtn' : 'connectScannerBtn'}" style="padding:7px 14px;font-size:12.5px;" ${!supported ? 'disabled' : ''}>${state.btScannerConnected ? 'Disconnect' : 'Connect'}</button>
      </div>
      <div style="color:var(--text-faint);font-size:11px;margin-top:8px;">Most scanners don't need this — pair them in your device's Bluetooth settings and they'll type barcodes directly into the scan boxes on Add/Discard Stock. This button is only for scanners in a special "data mode," which is uncommon.</div>
    </div>
  </div>`;
}

function renderOfflineBanner() {
  if (state.isOnline && state.offlineQueue.length === 0) return '';
  if (!state.isOnline) {
    return `<div class="card" style="margin-bottom:14px;border-color:var(--bad);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div>
        <div style="font-weight:600;color:var(--bad-soft);font-size:13.5px;">⚠ No connection</div>
        <div style="color:var(--text-faint);font-size:11.5px;margin-top:2px;">Sales still ring up normally and will sync automatically once you're back online.${state.offlineQueue.length > 0 ? ` ${state.offlineQueue.length} waiting now.` : ''}</div>
      </div>
    </div>`;
  }
  // Online but items still queued (e.g. the reconnect event fired before the server was actually reachable).
  return `<div class="card" style="margin-bottom:14px;border-color:var(--accent);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
    <div>
      <div style="font-weight:600;color:var(--accent-soft);font-size:13.5px;">🔄 ${state.offlineQueue.length} sale${state.offlineQueue.length === 1 ? '' : 's'} waiting to sync</div>
      <div style="color:var(--text-faint);font-size:11.5px;margin-top:2px;">${state.syncingOffline ? 'Syncing now…' : 'Rung up while offline.'}</div>
    </div>
    <button id="syncOfflineBtn" class="btn btn-accent" style="padding:8px 14px;font-size:12.5px;" ${state.syncingOffline ? 'disabled' : ''}>${state.syncingOffline ? 'Syncing…' : 'Sync now'}</button>
  </div>`;
}

function renderShiftBar() {
  if (state.turnoverResult) return renderTurnoverResult();
  if (state.showStartShiftPanel) return renderStartShiftPanel();
  if (state.showTurnoverPanel) return renderTurnoverPanel();
  if (state.currentShift) {
    const s = state.shiftSummary || {};
    return `<div class="card" style="margin-bottom:14px;border-color:var(--accent);">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
        <div>
          <div style="font-weight:600;font-size:13.5px;">You're the cashier · started ${fmtTime(state.currentShift.started_at)}</div>
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${s.salesCount || 0} sales · ${fmtMoney(s.salesTotal || 0)} · expected cash ${fmtMoney(s.expectedCash != null ? s.expectedCash : state.currentShift.starting_cash)}</div>
        </div>
        <button id="openTurnoverBtn" class="btn btn-accent" style="padding:8px 14px;font-size:12.5px;">Turn Over</button>
      </div>
    </div>`;
  }
  if (state.activeCashierShift) {
    const s = state.activeCashierSummary || {};
    return `<div class="card" style="margin-bottom:14px;color:var(--text-dim);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div>
        <div style="font-weight:600;font-size:13.5px;">Current cashier: ${escapeHtml(state.activeCashierShift.cashier_name)}</div>
        <div class="font-mono" style="font-size:11px;color:var(--text-faint);">since ${fmtTime(state.activeCashierShift.started_at)} · ${s.salesCount || 0} sales so far</div>
      </div>
    </div>`;
  }
  return `<div class="card" style="margin-bottom:14px;color:var(--text-faint);display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
    <div style="font-size:13px;">No cashier on duty — sales still record, but there's no cash reconciliation without a shift started.</div>
    <button id="openStartShiftBtn" class="btn btn-ghost" style="padding:8px 14px;font-size:12.5px;">Start Shift</button>
  </div>`;
}

function renderStartShiftPanel() {
  return `<div class="card fade-in" style="margin-bottom:14px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:10px;">Start shift</div>
    <label>Starting cash (petty cash float)</label>
    <input id="startingCashField" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(state.startingCashInput)}"/>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:8px;">Whatever's in the drawer when you begin — 0 is fine if you're not tracking a float.</div>
    <div style="display:flex;gap:10px;margin-top:14px;">
      <button id="cancelStartShiftBtn" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="confirmStartShiftBtn" class="btn btn-accent" style="flex:1;">Start shift</button>
    </div>
  </div>`;
}

function renderTurnoverPanel() {
  const s = state.shiftSummary || {};
  return `<div class="card fade-in" style="margin-bottom:14px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:10px;">Turn over shift</div>
    <div style="font-size:13px;color:var(--text-dim);">${s.salesCount || 0} sales this shift · total ${fmtMoney(s.salesTotal || 0)}</div>
    ${Object.entries(s.byMethod || {}).map(([m, v]) => `<div class="font-mono" style="font-size:11.5px;color:var(--text-faint);margin-top:2px;">${m}: ${fmtMoney(v)}</div>`).join('')}
    <div style="font-size:13px;color:var(--text-dim);margin-top:10px;">Starting cash: ${fmtMoney(state.currentShift.starting_cash)} → Expected cash now: <b>${fmtMoney(s.expectedCash != null ? s.expectedCash : 0)}</b></div>
    <div style="margin-top:12px;"><label>Counted cash</label><input id="turnoverCashField" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(state.turnoverCountedCash)}"/></div>
    <div style="margin-top:12px;"><label>Notes (optional)</label><input id="turnoverNotesField" placeholder="e.g. Short by 20, checking register tape" value="${escapeHtml(state.turnoverNotes)}"/></div>
    <div style="display:flex;gap:10px;margin-top:14px;">
      <button id="cancelTurnoverBtn" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="confirmTurnoverBtn" class="btn btn-accent" style="flex:1;">Complete turnover</button>
    </div>
  </div>`;
}

function renderTurnoverResult() {
  const r = state.turnoverResult;
  const varColor = r.variance === 0 ? 'var(--good-soft)' : r.variance < 0 ? 'var(--bad-soft)' : 'var(--accent-soft)';
  return `<div class="card fade-in" style="margin-bottom:14px;border-color:${r.variance === 0 ? 'var(--good)' : 'var(--accent)'};">
    <div class="font-display" style="font-size:17px;margin-bottom:10px;">Shift closed</div>
    <div style="display:flex;flex-direction:column;gap:4px;font-size:13.5px;">
      <div>Sales: ${fmtMoney(r.sales_total)} (${r.sales_count} transaction${r.sales_count === 1 ? '' : 's'})</div>
      <div>Expected cash: ${fmtMoney(r.expected_cash)}</div>
      <div>Counted cash: ${fmtMoney(r.counted_cash)}</div>
      <div style="font-weight:700;color:${varColor};">Variance: ${r.variance > 0 ? '+' : ''}${fmtMoney(r.variance)} ${r.variance === 0 ? '(exact match)' : r.variance < 0 ? '(short)' : '(over)'}</div>
    </div>
    <button id="closeTurnoverResultBtn" class="btn btn-accent btn-block" style="margin-top:14px;">Done</button>
  </div>`;
}

function renderVariantPicker() {
  const item = state.menuItems.find(i => i.id === state.pickingVariantFor);
  if (!item) return '';
  return `
  <div class="modal-backdrop">
    <div class="card fade-in" style="max-width:320px;width:100%;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <div class="font-display" style="font-size:16px;">${escapeHtml(item.name)}</div>
        <button id="closeVariantPickerBtn" style="background:none;border:none;color:var(--text-faint);font-size:22px;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${item.variants.map(v => `
          <button class="btn btn-ghost variant-pick-btn" data-variant="${v.id}" style="display:flex;justify-content:space-between;padding:12px 14px;font-size:14px;">
            <span>${escapeHtml(v.name)}</span>
            <span class="font-mono" style="font-weight:700;color:var(--accent-soft);">${fmtMoney(v.price)}</span>
          </button>`).join('')}
      </div>
    </div>
  </div>`;
}

function renderPosRegister() {
  if (state.menuItems.length === 0) {
    return `${state.showDevicesPanel ? renderDevicesPanel() : ''}
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">${renderDevicesButton()}</div>
    ${emptyState('No menu items yet', 'Ask an admin to add items under POS → Menu before ringing up sales.', null)}`;
  }
  const categories = ['All', ...new Set(state.menuItems.map(i => i.category || 'Uncategorized'))];
  const filtered = state.posCategory === 'All' ? state.menuItems : state.menuItems.filter(i => (i.category || 'Uncategorized') === state.posCategory);
  const totals = cartTotals();

  return `
  <div class="fade-in">
    ${state.showDevicesPanel ? renderDevicesPanel() : ''}
    <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">${renderDevicesButton()}</div>
    ${state.lastSale ? `
    <div class="card" style="border-color:${state.lastSale.offline ? 'var(--accent)' : 'var(--good)'};margin-bottom:14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
      <div>
        <div style="font-weight:600;color:${state.lastSale.offline ? 'var(--accent-soft)' : 'var(--good-soft)'};">${state.lastSale.offline ? '📴 Saved offline' : 'Sale complete'} — ${fmtMoney(state.lastSale.total)}</div>
        <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${state.lastSale.payment_method}${state.lastSale.offline ? ' · will get an invoice number once synced' : ''}</div>
      </div>
      ${!state.lastSale.offline ? `<div style="display:flex;gap:8px;">
        ${state.btPrinterConnected ? `<button id="printBluetoothBtn" class="btn btn-accent" style="padding:8px 16px;">📶 Print via Bluetooth</button>` : ''}
        <button id="printReceiptBtn" class="btn btn-ghost" style="padding:8px 16px;">🖨 Print receipt</button>
      </div>` : ''}
    </div>` : ''}
  <div class="fade-in">
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:14px;" class="scrollbar-thin">
      ${categories.map(c => `<button class="btn ${state.posCategory === c ? 'btn-accent' : 'btn-ghost'} pos-cat-btn" data-cat="${escapeHtml(c)}" style="white-space:nowrap;padding:8px 14px;">${escapeHtml(c)}</button>`).join('')}
    </div>

    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin-bottom:20px;">
      ${filtered.map(item => {
        const hasVariants = item.variants && item.variants.length > 0;
        const cartQty = state.cart.filter(l => l.itemId === item.id).reduce((s, l) => s + l.qty, 0);
        const lowestPrice = hasVariants ? Math.min(...item.variants.map(v => v.price)) : item.price;
        return `<div class="card pos-item-card" data-id="${item.id}" style="cursor:pointer;padding:14px;position:relative;${cartQty ? 'border-color:var(--accent);' : ''}">
          ${cartQty ? `<span class="badge badge-accent" style="position:absolute;top:10px;right:10px;">×${cartQty}</span>` : ''}
          <div style="font-weight:600;font-size:14px;">${escapeHtml(item.name)}</div>
          <div class="font-mono" style="color:var(--accent-soft);font-size:15px;font-weight:700;margin-top:6px;">${hasVariants ? 'From ' : ''}${fmtMoney(lowestPrice)}</div>
          ${hasVariants ? `<div style="color:var(--text-faint);font-size:10.5px;margin-top:2px;">${item.variants.length} sizes</div>` : ''}
        </div>`;
      }).join('')}
    </div>

    ${state.pickingVariantFor ? renderVariantPicker() : ''}

    ${state.cart.length > 0 ? `
    <div class="card" style="position:sticky;bottom:76px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <div class="font-display" style="font-size:16px;">Cart</div>
        <button id="clearCartBtn" style="background:none;border:none;color:var(--text-faint);font-size:12px;cursor:pointer;text-decoration:underline;">clear</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;max-height:200px;overflow-y:auto;" class="scrollbar-thin">
        ${state.cart.map(l => `
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:13.5px;">
            <span>${escapeHtml(l.name)}</span>
            <div style="display:flex;align-items:center;gap:8px;">
              <button class="btn btn-ghost cart-qty-btn" data-id="${l.itemId}" data-variant="${l.variantId || ''}" data-delta="-1" style="padding:2px 9px;font-size:14px;">−</button>
              <span class="font-mono" style="min-width:18px;text-align:center;">${l.qty}</span>
              <button class="btn btn-ghost cart-qty-btn" data-id="${l.itemId}" data-variant="${l.variantId || ''}" data-delta="1" style="padding:2px 9px;font-size:14px;">+</button>
              <span class="font-mono" style="min-width:64px;text-align:right;">${fmtMoney(l.price * l.qty)}</span>
            </div>
          </div>`).join('')}
      </div>

      <div style="margin-top:14px;">
        <label style="margin-bottom:6px;">Customer name (optional)</label>
        <input id="pos-customer-name" placeholder="e.g. Juan" value="${escapeHtml(state.posCustomerName)}"/>
      </div>

      <div style="margin-top:14px;">
        <label style="margin-bottom:6px;">Order type</label>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
          ${[['dine_in', 'Dine in'], ['takeout', 'Takeout'], ['delivery', 'Delivery'], ['food_panda', 'Food Panda']].map(([id, label]) =>
            `<button class="btn ${state.posOrderType === id ? 'btn-accent' : 'btn-ghost'} pos-ordertype-btn" data-type="${id}" style="padding:8px;font-size:12.5px;">${label}</button>`
          ).join('')}
        </div>
      </div>

      <div style="margin-top:14px;display:flex;gap:8px;">
        <button class="btn ${state.posDiscount === '' ? 'btn-accent' : 'btn-ghost'} pos-discount-btn" data-discount="" style="flex:1;padding:8px;font-size:12.5px;">No discount</button>
        <button class="btn ${state.posDiscount === 'senior_pwd' ? 'btn-accent' : 'btn-ghost'} pos-discount-btn" data-discount="senior_pwd" style="flex:1;padding:8px;font-size:12.5px;">Senior/PWD −20%</button>
      </div>

      <div style="margin-top:12px;font-family:'IBM Plex Mono',monospace;font-size:12.5px;color:var(--text-dim);display:flex;flex-direction:column;gap:3px;">
        <div style="display:flex;justify-content:space-between;"><span>Subtotal</span><span>${fmtMoney(totals.subtotal)}</span></div>
        ${totals.discountAmount > 0 ? `<div style="display:flex;justify-content:space-between;color:var(--accent-soft);"><span>Discount</span><span>−${fmtMoney(totals.discountAmount)}</span></div>` : ''}
        <div style="display:flex;justify-content:space-between;"><span>VAT (included)</span><span>${fmtMoney(totals.vatAmount)}</span></div>
        <div style="display:flex;justify-content:space-between;font-size:16px;color:var(--text);font-weight:700;margin-top:4px;"><span>Total</span><span>${fmtMoney(totals.total)}</span></div>
      </div>

      <div style="margin-top:14px;display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${['Cash', 'Card', 'GCash', 'Food Panda'].map(m => `<button class="btn ${state.posPayment === m ? 'btn-accent' : 'btn-ghost'} pos-payment-btn" data-method="${m}" style="padding:9px;font-size:13px;">${m}</button>`).join('')}
      </div>

      <button id="checkoutBtn" class="btn btn-good btn-block" style="margin-top:14px;">Complete sale — ${fmtMoney(totals.total)}</button>
    </div>` : ''}
  </div>`;
}

/* ============================= POS: SALES HISTORY ============================= */
function orderTypeLabel(type) {
  return { dine_in: 'Dine In', takeout: 'Takeout', delivery: 'Delivery', food_panda: 'Food Panda' }[type] || type;
}
function orderTypeBadgeClass(type) {
  return { dine_in: 'badge-good', takeout: 'badge-accent', delivery: 'badge-accent', food_panda: 'badge-bad' }[type] || 'badge-accent';
}
function minutesAgo(sqliteUtc) {
  const d = new Date(sqliteUtc.replace(' ', 'T') + 'Z');
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
}

function renderPosKitchen() {
  const orders = state.kitchenOrders;
  return `
  <div class="fade-in">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <div class="font-display" style="font-size:20px;">Kitchen queue</div>
      <div style="display:flex;gap:8px;align-items:center;">
        <button class="btn ${state.kitchenIncludeServed ? 'btn-accent' : 'btn-ghost'}" id="kitchenToggleServed" style="padding:8px 12px;font-size:12.5px;">Show completed</button>
        <button class="btn btn-ghost" id="kitchenRefreshBtn" style="padding:8px 12px;font-size:12.5px;">⟳ Refresh</button>
      </div>
    </div>
    ${orders.length === 0 ? `<div class="card" style="text-align:center;padding:40px 20px;color:var(--text-faint);">
        <div class="font-display" style="font-size:18px;color:var(--text-dim);">All caught up</div>
        <div style="margin-top:6px;">No orders waiting on prep.</div>
      </div>` :
    `<div style="display:flex;flex-direction:column;gap:10px;">
      ${orders.map(o => {
        const mins = minutesAgo(o.created_at);
        const urgent = o.status === 'pending' && mins >= 10;
        return `<div class="card" style="border-color:${urgent ? 'var(--bad)' : 'var(--border-soft)'};${o.status === 'served' ? 'opacity:0.55;' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;">
            <span class="badge ${orderTypeBadgeClass(o.order_type)}">${orderTypeLabel(o.order_type)}</span>
            <span class="font-mono" style="font-size:11.5px;color:${urgent ? 'var(--bad-soft)' : 'var(--text-faint)'};">${mins === 0 ? 'just now' : mins + 'm ago'}</span>
          </div>
          ${o.customer_name ? `<div class="font-display" style="font-size:16px;color:var(--accent-soft);margin-bottom:6px;">${escapeHtml(o.customer_name)}</div>` : ''}
          <div style="font-size:14.5px;line-height:1.6;">
            ${o.items.map(i => `<div>${i.qty}× ${escapeHtml(i.name)}</div>`).join('')}
          </div>
          ${o.status === 'served' ? `
            <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:8px;">served by ${escapeHtml(o.served_by)} · ${fmtTime(o.served_at)}</div>
            <button class="btn btn-ghost kitchen-unserve-btn" data-id="${o.id}" style="margin-top:8px;padding:7px 14px;font-size:12.5px;">Undo</button>
          ` : `
            <button class="btn btn-good kitchen-serve-btn" data-id="${o.id}" style="margin-top:10px;width:100%;padding:11px;">✓ Mark served</button>
          `}
        </div>`;
      }).join('')}
    </div>`}
  </div>`;
}

/* ============================= POS: RECIPES ============================= */
function renderPosRecipes() {
  const categories = ['All', ...new Set(state.menuItems.map(i => i.category || 'Uncategorized'))];
  const items = state.posCategory === 'All' ? state.menuItems : state.menuItems.filter(i => (i.category || 'Uncategorized') === state.posCategory);
  return `
  <div class="fade-in">
    <div class="font-display" style="font-size:20px;margin-bottom:6px;">Recipes</div>
    <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">Select a menu item to see how it's made.</div>
    <div style="display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:16px;" class="scrollbar-thin">
      ${categories.map(c => `<button class="btn ${state.posCategory === c ? 'btn-accent' : 'btn-ghost'} pos-cat-btn" data-cat="${escapeHtml(c)}" style="white-space:nowrap;padding:8px 14px;">${escapeHtml(c)}</button>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${items.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No menu items yet.</div>` :
      items.map(item => {
        const isViewing = state.recipeViewingId === item.id;
        const isEditing = state.editingRecipeId === item.id;
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
            <div>
              <div style="font-weight:600;font-size:14.5px;">${escapeHtml(item.name)}</div>
              <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(item.category || '—')} · ${fmtMoney(item.price)}</div>
            </div>
            <div style="display:flex;gap:8px;">
              <button class="btn ${isViewing ? 'btn-accent' : 'btn-ghost'} view-recipe-btn" data-id="${item.id}" style="padding:7px 14px;font-size:12.5px;">${isViewing ? 'Hide' : 'View'} Recipe</button>
              ${state.user.role === 'admin' ? `<button class="btn btn-ghost edit-recipe-btn" data-id="${item.id}" style="padding:7px 14px;font-size:12.5px;">${item.recipe ? 'Edit' : '+ Add'} Recipe</button>` : ''}
            </div>
          </div>
          ${isEditing ? `
            <div style="margin-top:12px;">
              <textarea id="recipe-draft-${item.id}" rows="6" placeholder="e.g.&#10;1. Pull a double shot of espresso.&#10;2. Steam 150ml milk to 65°C.&#10;3. Pour over espresso, hold back foam.">${escapeHtml(state.recipeDraft)}</textarea>
              <div style="margin-top:12px;">
                <label>Finished-product photo (optional)</label>
                <div style="display:flex;align-items:center;gap:12px;">
                  ${item.recipe_image ? `<img src="/api/recipe-image/${item.id}?t=${Date.now()}" alt="Finished ${escapeHtml(item.name)}" style="width:64px;height:64px;border-radius:8px;object-fit:cover;border:1px solid var(--border-soft);"/>` : ''}
                  <div style="flex:1;">
                    <input id="recipe-image-file-${item.id}" type="file" accept="image/*"/>
                    <div style="display:flex;gap:8px;margin-top:8px;">
                      <button class="btn btn-accent upload-recipe-image-btn" data-id="${item.id}" style="padding:7px 12px;font-size:12px;">Upload photo</button>
                      ${item.recipe_image ? `<button class="btn btn-ghost remove-recipe-image-btn" data-id="${item.id}" style="padding:7px 12px;font-size:12px;">Remove photo</button>` : ''}
                    </div>
                  </div>
                </div>
              </div>
              <div style="display:flex;gap:10px;margin-top:14px;">
                <button class="btn btn-ghost cancel-recipe-btn" style="flex:1;">Cancel</button>
                <button class="btn btn-accent save-recipe-btn" data-id="${item.id}" style="flex:1;">Save recipe</button>
              </div>
            </div>
          ` : isViewing ? `
            <div style="margin-top:12px;padding-top:12px;border-top:1px dashed var(--border-soft);">
              ${item.recipe_image ? `<img src="/api/recipe-image/${item.id}" alt="Finished ${escapeHtml(item.name)}" style="width:100%;max-width:320px;border-radius:10px;margin-bottom:12px;display:block;"/>` : ''}
              ${item.recipe ? `<div style="font-size:13.5px;color:var(--text-dim);line-height:1.6;white-space:pre-wrap;">${escapeHtml(item.recipe)}</div>` : `<div style="color:var(--text-faint);font-size:13px;">No recipe added yet.${state.user.role === 'admin' ? '' : ' Ask an admin to add one.'}</div>`}
            </div>
          ` : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderPosHistory() {
  const s = state.salesSummary;
  return `
  <div class="fade-in">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="salesDatePick" value="${state.salesDate}" max="${todayStr()}" style="max-width:180px;"/>
      <div class="font-display" style="font-size:15px;color:var(--text-dim);">${fmtDateLong(state.salesDate)}</div>
    </div>

    ${s ? `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:16px;">
      ${statCard('Transactions', s.transactionCount, 'accent')}
      ${statCard('Gross sales', fmtMoney(s.grossTotal), 'good')}
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div class="font-display" style="font-size:15px;margin-bottom:10px;">By payment method</div>
      ${Object.entries(s.byMethod).map(([m, v]) => `
        <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:6px 0;border-bottom:1px dashed var(--border-soft);">
          <span>${m}</span><span class="font-mono">${fmtMoney(v)}</span>
        </div>`).join('')}
    </div>
    ${s.bestSellers.length > 0 ? `
    <div class="card" style="margin-bottom:16px;">
      <div class="font-display" style="font-size:15px;margin-bottom:10px;">Best sellers</div>
      ${s.bestSellers.slice(0, 6).map(b => `
        <div style="display:flex;justify-content:space-between;font-size:13.5px;padding:6px 0;border-bottom:1px dashed var(--border-soft);">
          <span>${escapeHtml(b.name)}</span><span class="font-mono" style="color:var(--text-faint);">${b.qty} sold · ${fmtMoney(b.revenue)}</span>
        </div>`).join('')}
    </div>` : ''}
    ` : ''}

    <div class="font-display" style="font-size:16px;margin:18px 0 8px;">Transactions</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.salesList.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No sales this day.</div>` :
      state.salesList.map(sale => {
        const refundsForSale = (state.refundsList || []).filter(r => r.sale_id === sale.id);
        const refundedTotal = refundsForSale.reduce((s, r) => s + r.amount, 0);
        const remaining = sale.total - refundedTotal;
        return `
        <div class="card" style="${sale.voided ? 'opacity:0.5;' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div class="font-mono" style="font-size:11px;color:var(--accent-soft);margin-bottom:2px;">${escapeHtml(sale.invoice_no || '—')}</div>
              ${sale.customer_name ? `<div style="font-size:13.5px;font-weight:600;">${escapeHtml(sale.customer_name)}</div>` : ''}
              <div style="font-size:13.5px;">${sale.items.map(i => `${i.qty}× ${escapeHtml(i.name)}`).join(', ')}</div>
              <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:4px;">
                <span class="badge ${orderTypeBadgeClass(sale.order_type)}" style="margin-right:6px;">${orderTypeLabel(sale.order_type)}</span>
                ${sale.payment_method} · ${escapeHtml(sale.cashier_name)} · ${fmtTime(sale.created_at)}
              </div>
              ${sale.voided ? `<div class="font-mono" style="font-size:11px;color:var(--bad-soft);margin-top:4px;">VOIDED by ${escapeHtml(sale.voided_by)} · ${escapeHtml(sale.void_reason || '')}</div>` : ''}
              ${refundedTotal > 0 ? `<div class="font-mono" style="font-size:11px;color:var(--accent-soft);margin-top:4px;">Refunded ${fmtMoney(refundedTotal)}${remaining > 0 ? ` · ${fmtMoney(remaining)} remaining` : ' · fully refunded'}</div>` : ''}
            </div>
            <div style="text-align:right;">
              <div class="font-mono" style="font-weight:700;">${fmtMoney(sale.total)}</div>
              ${!sale.voided && state.user.role === 'admin' ? `
                <div style="display:flex;flex-direction:column;gap:4px;margin-top:6px;">
                  ${remaining > 0.004 ? `<button class="btn btn-ghost refund-sale-btn" data-id="${sale.id}" data-remaining="${remaining}" style="padding:4px 10px;font-size:11px;">Refund</button>` : ''}
                  <button class="btn btn-ghost void-sale-btn" data-id="${sale.id}" style="padding:4px 10px;font-size:11px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Void</button>
                </div>` : ''}
            </div>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

/* ============================= POS: MENU ITEMS (ADMIN) ============================= */
function renderApprovals() {
  const filters = [['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied'], ['', 'All']];
  const requests = state.approvalRequests || [];
  return `
  <div class="fade-in">
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      ${filters.map(([id, label]) => `<button class="btn ${state.approvalsFilter === id ? 'btn-accent' : 'btn-ghost'} approvals-filter-btn" data-status="${id}" style="padding:7px 12px;font-size:12.5px;">${label}</button>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${requests.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">Nothing here.</div>` :
      requests.map(r => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="font-weight:600;">${r.type === 'void' ? 'Void' : 'Refund'} — ${escapeHtml(r.invoice_no || 'Unknown sale')}</div>
              <div class="font-mono" style="font-size:11.5px;color:var(--text-faint);margin-top:2px;">
                Requested by ${escapeHtml(r.requested_by_name)} · ${fmtDateTimeShort(r.created_at)}
                ${r.sale_total != null ? ` · sale total ${fmtMoney(r.sale_total)}` : ''}
                ${r.type === 'refund' && r.amount != null ? ` · refund amount ${fmtMoney(r.amount)}` : ''}
              </div>
              ${r.reason ? `<div style="font-size:13px;color:var(--text-dim);margin-top:8px;">"${escapeHtml(r.reason)}"</div>` : ''}
            </div>
            <span class="badge ${r.status === 'approved' ? 'badge-good' : r.status === 'denied' ? 'badge-bad' : 'badge-accent'}">${r.status}</span>
          </div>
          ${r.status === 'pending' ? `
            <div style="display:flex;gap:8px;margin-top:12px;">
              <button class="btn btn-good approval-review-btn" data-id="${r.id}" data-status="approved" style="flex:1;padding:8px;font-size:12.5px;">Approve</button>
              <button class="btn btn-bad approval-review-btn" data-id="${r.id}" data-status="denied" style="flex:1;padding:8px;font-size:12.5px;">Deny</button>
            </div>` : r.reviewed_by ? `<div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:10px;">reviewed by ${escapeHtml(r.reviewed_by)}</div>` : ''}
        </div>`).join('')}
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:14px;">Staff without approval authority land here when they try to void or refund a sale — approving actually completes the void/refund; denying leaves the sale untouched.</div>
  </div>`;
}

function renderShiftsHistory() {
  const shifts = state.shiftsHistory || [];
  const closedShifts = shifts.filter(s => s.status === 'closed');
  const totalVariance = closedShifts.reduce((sum, s) => sum + (s.variance || 0), 0);
  const shortCount = closedShifts.filter(s => (s.variance || 0) < 0).length;

  return `
  <div class="fade-in">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="shiftsStartPick" value="${state.shiftsStart}" max="${todayStr()}" style="max-width:160px;"/>
      <span style="color:var(--text-faint);">to</span>
      <input type="date" id="shiftsEndPick" value="${state.shiftsEnd}" max="${todayStr()}" style="max-width:160px;"/>
    </div>

    ${shifts.length === 0 ? '' : `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;">
      ${statCard('Shifts', shifts.length, 'accent')}
      ${statCard('Short shifts', shortCount, shortCount > 0 ? 'bad' : 'good')}
      ${statCard('Net variance', (totalVariance >= 0 ? '+' : '') + fmtMoney(totalVariance), totalVariance === 0 ? 'good' : totalVariance < 0 ? 'bad' : 'accent')}
    </div>`}

    <div style="display:flex;flex-direction:column;gap:10px;">
      ${shifts.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No shifts in this range.</div>` :
      shifts.map(s => {
        const varColor = s.status !== 'closed' ? 'var(--text-faint)' : s.variance === 0 ? 'var(--good-soft)' : s.variance < 0 ? 'var(--bad-soft)' : 'var(--accent-soft)';
        return `<div class="card" style="${s.status === 'open' ? 'border-color:var(--accent);' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="font-weight:600;">${escapeHtml(s.cashier_name)}</div>
              <div class="font-mono" style="font-size:11.5px;color:var(--text-faint);margin-top:2px;">
                ${fmtDateTimeShort(s.started_at)} → ${s.ended_at ? fmtDateTimeShort(s.ended_at) : 'still open'}
              </div>
            </div>
            <span class="badge ${s.status === 'open' ? 'badge-accent' : ''}">${s.status === 'open' ? 'Open' : 'Closed'}</span>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;font-size:13px;">
            <div><span style="color:var(--text-faint);">Starting cash</span><br/><span class="font-mono">${fmtMoney(s.starting_cash)}</span></div>
            <div><span style="color:var(--text-faint);">Sales total</span><br/><span class="font-mono">${s.sales_total != null ? fmtMoney(s.sales_total) : '—'}${s.sales_count != null ? ` (${s.sales_count})` : ''}</span></div>
            <div><span style="color:var(--text-faint);">Expected cash</span><br/><span class="font-mono">${s.expected_cash != null ? fmtMoney(s.expected_cash) : '—'}</span></div>
            <div><span style="color:var(--text-faint);">Counted cash</span><br/><span class="font-mono">${s.counted_cash != null ? fmtMoney(s.counted_cash) : '—'}</span></div>
          </div>
          ${s.sales_by_method ? `<div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:8px;">${Object.entries(s.sales_by_method).map(([m, v]) => `${m}: ${fmtMoney(v)}`).join(' · ')}</div>` : ''}
          ${s.status === 'closed' ? `<div style="margin-top:10px;font-weight:700;color:${varColor};font-size:13.5px;">Variance: ${s.variance > 0 ? '+' : ''}${fmtMoney(s.variance)} ${s.variance === 0 ? '(exact match)' : s.variance < 0 ? '(short)' : '(over)'}</div>` : ''}
          ${s.notes ? `<div style="font-size:12.5px;color:var(--text-dim);margin-top:6px;">"${escapeHtml(s.notes)}"</div>` : ''}
          ${s.status === 'closed' ? (s.verified_by ? `
            <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-soft);">
              <div style="color:var(--good-soft);font-size:12.5px;font-weight:600;">✓ Verified by ${escapeHtml(s.verified_by)} · counted ${fmtMoney(s.verified_amount)} · ${fmtDateTimeShort(s.verified_at)}</div>
              ${s.verified_amount !== s.counted_cash ? `<div style="color:var(--bad-soft);font-size:12px;margin-top:3px;">⚠ Differs from what ${escapeHtml(s.cashier_name)} reported by ${fmtMoney(Math.abs(s.verified_amount - s.counted_cash))}</div>` : ''}
            </div>
          ` : `<button class="btn btn-accent verify-shift-btn" data-id="${s.id}" style="margin-top:10px;width:100%;padding:9px;font-size:12.5px;">Verify this handoff</button>`) : ''}
        </div>`;
      }).join('')}
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:14px;">Use this to check what a previous cashier's shift totaled — starting cash, sales, expected vs. counted cash — when handing over to the next person. The incoming cashier can verify a handoff themselves with their own email + PIN.</div>
  </div>`;
}

function renderPosItems() {
  return `
  <div class="fade-in">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <div class="font-display" style="font-size:17px;">Menu items</div>
      <button id="newMenuItemBtn" class="btn btn-accent" style="padding:8px 14px;">+ New</button>
    </div>
    ${state.editMenuItem ? renderMenuItemForm() : ''}
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.menuItems.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No menu items yet.</div>` :
      state.menuItems.map(item => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">${escapeHtml(item.name)}</div>
            <div class="font-mono" style="font-size:11px;color:var(--text-faint);">${escapeHtml(item.category || '—')} · ${fmtMoney(item.price)}${item.barcode ? ' · ' + escapeHtml(item.barcode) : ''}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost edit-menu-item-btn" data-id="${item.id}" style="padding:6px 12px;font-size:13px;">Edit</button>
            <button class="btn btn-ghost del-menu-item-btn" data-id="${item.id}" style="padding:6px 12px;font-size:13px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}

function renderMenuItemForm() {
  const i = state.editMenuItem;
  const isNew = !i._existing;
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">${isNew ? 'New menu item' : 'Edit menu item'}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
      <div style="grid-column:1/-1;"><label>Name</label><input id="mf-name" value="${escapeHtml(i.name)}"/></div>
      <div><label>Category</label><input id="mf-category" value="${escapeHtml(i.category || '')}" placeholder="e.g. Coffee"/></div>
      <div><label>Price (VAT-inclusive)</label><input id="mf-price" type="number" min="0" step="0.01" value="${i.price != null ? i.price : ''}"/></div>
      <div style="grid-column:1/-1;"><label>Barcode (optional)</label><input id="mf-barcode" value="${escapeHtml(i.barcode || '')}" placeholder="scan or type"/></div>
      <div style="grid-column:1/-1;"><label>Recipe (optional)</label><textarea id="mf-recipe" rows="4" placeholder="Steps for kitchen staff to prepare this item">${escapeHtml(i.recipe || '')}</textarea></div>
    </div>

    <div class="font-display" style="font-size:14px;color:var(--text-faint);margin:18px 0 8px;">Sizes (optional)</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${(i.variants_draft || []).map((v, idx) => `
        <div style="display:flex;gap:8px;align-items:center;">
          <input class="mf-variant-name" data-idx="${idx}" placeholder="e.g. 16oz" value="${escapeHtml(v.name || '')}" style="flex:1;"/>
          <input class="mf-variant-price" data-idx="${idx}" type="number" min="0" step="0.01" placeholder="Price" value="${v.price != null ? v.price : ''}" style="width:100px;"/>
          <button class="btn btn-ghost mf-variant-remove" data-idx="${idx}" style="padding:8px 12px;color:var(--bad-soft);">×</button>
        </div>`).join('')}
    </div>
    <button id="mf-add-variant" class="btn btn-ghost btn-block" style="margin-top:10px;padding:8px;font-size:12.5px;">+ Add a size</button>
    <div style="color:var(--text-faint);font-size:11px;margin-top:8px;">If you add sizes here, staff will pick one at checkout instead of using the flat price above — the price above is only used for items with no sizes.</div>
    <div style="color:var(--text-faint);font-size:11px;margin-top:8px;">${isNew ? 'Save this item first, then add a finished-product photo from the Recipes tab.' : 'To add or change the finished-product photo, use the Recipes tab.'}</div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="mf-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="mf-save" class="btn btn-accent" style="flex:1;">Save item</button>
    </div>
  </div>`;
}

/* ============================= TIME CLOCK ============================= */
function renderTimeClock() {
  return `
  <div class="fade-in">
    ${state.attentionNote ? `
    <div class="card" style="border-color:var(--accent);margin-bottom:18px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-size:16px;">📌</span>
        <span class="font-display" style="font-size:14px;color:var(--accent-soft);">Attention</span>
      </div>
      <div style="font-size:13.5px;color:var(--text-dim);line-height:1.5;white-space:pre-wrap;">${escapeHtml(state.attentionNote)}</div>
    </div>` : ''}

    <div class="card" style="margin-bottom:18px;">
      <div class="font-display" style="font-size:15px;margin-bottom:12px;">Time Tracker</div>
      <div style="display:flex;gap:10px;">
        <button id="ttClockInBtn" class="btn btn-good" style="flex:1;padding:14px;font-size:14px;">Clock In</button>
        <button id="ttClockOutBtn" class="btn btn-bad" style="flex:1;padding:14px;font-size:14px;">Clock Out</button>
      </div>
      <div style="color:var(--text-faint);font-size:11.5px;margin-top:10px;">Enter your email + PIN to confirm it's you — works for anyone on this shared screen, not just whoever's logged in.</div>
    </div>

    <div class="font-display" style="font-size:16px;margin-bottom:8px;">Team right now</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px;">
      ${!state.liveRoster || state.liveRoster.staff.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No active staff.</div>` :
      state.liveRoster.staff.map(s => renderRosterRow(s)).join('')}
    </div>

    <div class="font-display" style="font-size:16px;margin-bottom:8px;">Today's punches</div>
    <div class="card" style="margin-bottom:16px;">
      ${state.myTimeEntries.length === 0 ? `<div style="color:var(--text-faint);font-size:13px;">No punches yet today.</div>` :
      state.myTimeEntries.map(e => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft);font-size:13.5px;">
          <span>${state.user.role === 'admin' ? `<span style="font-weight:600;">${escapeHtml(e.user_name)}</span> · ` : ''}${fmtTime(e.clock_in)} → ${e.clock_out ? fmtTime(e.clock_out) : 'ongoing'}</span>
          <span class="font-mono" style="color:var(--text-faint);">${e.clock_out ? hoursLabel((new Date(e.clock_out.replace(' ', 'T') + 'Z') - new Date(e.clock_in.replace(' ', 'T') + 'Z')) / 3600000) : ''}</span>
        </div>`).join('')}
    </div>

    <div class="font-display" style="font-size:16px;margin-bottom:8px;">Today's breaks</div>
    <div class="card">
      ${state.myTodayBreaks.length === 0 ? `<div style="color:var(--text-faint);font-size:13px;">No breaks logged today.</div>` :
      state.myTodayBreaks.map(b => `
        <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft);font-size:13.5px;">
          <span>${state.user.role === 'admin' ? `<span style="font-weight:600;">${escapeHtml(b.user_name)}</span> · ` : ''}${b.type === 'lunch' ? 'Lunch' : 'Break'}: ${fmtTime(b.start_time)} → ${b.end_time ? fmtTime(b.end_time) : 'ongoing'}</span>
          ${b.minutes_used !== null ? `<span class="badge ${b.over_by > 0 ? 'badge-bad' : 'badge-good'}">${Math.round(b.minutes_used)}m${b.over_by > 0 ? ` · +${b.over_by}m over` : ''}</span>` : ''}
        </div>`).join('')}
    </div>
  </div>`;
}

/* ============================= TIME: TEAM LOG (ADMIN) ============================= */
function renderTimeTeam() {
  return `
  <div class="fade-in">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="teamDatePick" value="${state.teamTimeDate}" max="${todayStr()}" style="max-width:180px;"/>
      <div class="font-display" style="font-size:15px;color:var(--text-dim);">${fmtDateLong(state.teamTimeDate)}</div>
      <button id="markAttendanceBtn" class="btn btn-ghost" style="padding:8px 14px;margin-left:auto;">+ Mark absent/AWOL/undertime</button>
    </div>
    ${state.markAttendance ? renderAttendanceMarkForm() : ''}
    ${state.editTimeEntry ? renderTimeEntryForm() : ''}

    <div class="font-display" style="font-size:16px;margin-bottom:8px;">Punches</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
      ${state.teamTimeEntries.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No punches this day.</div>` :
      state.teamTimeEntries.map(e => {
        const hrs = e.clock_out ? (new Date(e.clock_out.replace(' ', 'T') + 'Z') - new Date(e.clock_in.replace(' ', 'T') + 'Z')) / 3600000 : null;
        return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">${escapeHtml(e.user_name)}</div>
            <div class="font-mono" style="font-size:11.5px;color:var(--text-faint);">${fmtTime(e.clock_in)} → ${e.clock_out ? fmtTime(e.clock_out) : 'ongoing'}${hrs !== null ? ' · ' + hoursLabel(hrs) : ''}${e.edited_by ? ` · edited by ${escapeHtml(e.edited_by)}` : ''}</div>
          </div>
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost edit-time-entry-btn" data-id="${e.id}" style="padding:6px 12px;font-size:13px;">Edit</button>
            <button class="btn btn-ghost del-time-entry-btn" data-id="${e.id}" style="padding:6px 12px;font-size:13px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
          </div>
        </div>`;
      }).join('')}
    </div>

    ${state.teamBreaks.length > 0 ? `
    <div class="font-display" style="font-size:16px;margin-bottom:8px;">Breaks &amp; lunch</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:18px;">
      ${state.teamBreaks.map(b => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">${escapeHtml(b.user_name)}</div>
            <div class="font-mono" style="font-size:11.5px;color:var(--text-faint);">${b.type === 'lunch' ? 'Lunch' : 'Break'}: ${fmtTime(b.start_time)} → ${b.end_time ? fmtTime(b.end_time) : 'ongoing'}</div>
          </div>
          ${b.minutes_used !== null ? `<span class="badge ${b.over_by > 0 ? 'badge-bad' : 'badge-good'}">${Math.round(b.minutes_used)}m${b.over_by > 0 ? ` · +${b.over_by}m over` : ''}</span>` : ''}
        </div>`).join('')}
    </div>` : ''}

    ${state.statusMarks.length > 0 ? `
    <div class="font-display" style="font-size:16px;margin-bottom:8px;">Attendance marks</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.statusMarks.map(s => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">${escapeHtml(s.user_name)} <span class="badge ${s.status === 'absent' ? 'badge-bad' : s.status === 'awol' ? 'badge-bad' : 'badge-accent'}" style="margin-left:6px;">${s.status.toUpperCase()}</span></div>
            ${s.notes ? `<div style="font-size:12.5px;color:var(--text-faint);margin-top:3px;">${escapeHtml(s.notes)}</div>` : ''}
            <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:3px;">marked by ${escapeHtml(s.marked_by)}</div>
          </div>
          <button class="btn btn-ghost del-attendance-mark-btn" data-id="${s.id}" style="padding:6px 12px;font-size:13px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Remove</button>
        </div>`).join('')}
    </div>` : ''}
  </div>`;
}

function renderAttendanceMarkForm() {
  const m = state.markAttendance;
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">Mark attendance — ${fmtDateLong(state.teamTimeDate)}</div>
    <label>Staff</label>
    <select id="am-user">
      ${state.users.filter(u => u.active).map(u => `<option value="${u.id}" ${m.userId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
    </select>
    <div style="margin-top:12px;display:flex;gap:8px;">
      ${['absent', 'awol', 'undertime'].map(s => `<button class="btn ${m.status === s ? 'btn-accent' : 'btn-ghost'} am-status-btn" data-status="${s}" style="flex:1;padding:9px;font-size:13px;text-transform:capitalize;">${s}</button>`).join('')}
    </div>
    <div style="margin-top:12px;"><label>Notes (optional)</label><input id="am-notes" placeholder="e.g. called in sick" value="${escapeHtml(m.notes || '')}"/></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="am-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="am-save" class="btn btn-accent" style="flex:1;">Save</button>
    </div>
  </div>`;
}

function renderTimeEntryForm() {
  const e = state.editTimeEntry;
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:4px;">Edit punch — ${escapeHtml(e.user_name)}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
      <div><label>Clock in</label><input id="tf-in" type="datetime-local" value="${utcToLocalInput(e.clock_in)}"/></div>
      <div><label>Clock out</label><input id="tf-out" type="datetime-local" value="${utcToLocalInput(e.clock_out)}"/></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="tf-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="tf-save" class="btn btn-accent" style="flex:1;">Save</button>
    </div>
  </div>`;
}

/* ============================= TIME: PAYROLL (ADMIN) ============================= */
function renderTimePayroll() {
  const p = state.payrollData;
  return `
  <div class="fade-in">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="payrollStartPick" value="${state.payrollStart}" max="${todayStr()}"/>
      <span style="color:var(--text-faint);">to</span>
      <input type="date" id="payrollEndPick" value="${state.payrollEnd}" max="${todayStr()}"/>
    </div>
    ${!p ? '' : `
    <div class="card">
      <table class="ledger-table">
        <thead><tr><th>Staff</th><th>Regular</th><th>OT</th><th>Total hrs</th><th>Gross pay</th><th>Schedule flags</th></tr></thead>
        <tbody>
          ${p.payroll.map(row => { const ex = row.exceptions || { total: 0, pending: 0, approved: 0, denied: 0 }; return `<tr>
            <td>${escapeHtml(row.user.name)}</td>
            <td>${hoursLabel(row.regularHours)}</td>
            <td style="color:var(--accent-soft);">${row.otHours > 0 ? hoursLabel(row.otHours) : '—'}</td>
            <td>${hoursLabel(row.totalHours)}</td>
            <td style="font-weight:700;">${fmtMoney(row.grossPay)}</td>
            <td>${ex.total === 0 ? '<span style="color:var(--text-faint);">—</span>' : `
              ${ex.pending > 0 ? `<span class="badge badge-accent" style="margin-right:4px;">${ex.pending} pending</span>` : ''}
              ${ex.denied > 0 ? `<span class="badge badge-bad" style="margin-right:4px;">${ex.denied} denied</span>` : ''}
              ${ex.approved > 0 ? `<span class="badge badge-good">${ex.approved} approved</span>` : ''}
            `}</td>
          </tr>`; }).join('')}
        </tbody>
      </table>
    </div>
    <div class="card" style="margin-top:12px;text-align:right;">
      <span style="color:var(--text-faint);font-size:13px;">Total payroll: </span>
      <span class="font-mono" style="font-size:17px;font-weight:700;color:var(--accent-soft);">${fmtMoney(p.payroll.reduce((s, r) => s + r.grossPay, 0))}</span>
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:10px;">Overtime is anything past ${p.standardHours}h in a single day, paid at ${p.otMultiplier}×. "Schedule flags" are late arrivals or clock-ins without a scheduled shift — review pending ones under Time Clock → Requests → Exceptions before finalizing pay. Set hourly rates per person under Inventory → Admin → Team.</div>
    `}
  </div>`;
}

/* ============================= TIME: EVALUATE (ADMIN) ============================= */
function renderTimeEval() {
  const modes = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year'], ['custom', 'Custom']];
  const d = state.evalData;
  return `
  <div class="fade-in">
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      ${modes.map(([id, label]) => `<button class="btn ${state.evalMode === id ? 'btn-accent' : 'btn-ghost'} eval-mode-btn" data-mode="${id}">${label}</button>`).join('')}
    </div>
    <div style="margin-bottom:16px;">
      ${state.evalMode === 'day' ? `<input type="date" id="evalDatePick" value="${state.evalDate}" max="${todayStr()}" style="max-width:180px;"/>` :
        state.evalMode === 'week' ? `<input type="week" id="evalWeekPick" value="${state.evalWeek}" style="max-width:180px;"/><div style="color:var(--text-faint);font-size:11.5px;margin-top:6px;">${weekRangeLabel(isoWeekToMonday(state.evalWeek))}</div>` :
        state.evalMode === 'month' ? `<input type="month" id="evalMonthPick" value="${state.evalMonth}" max="${monthStr(new Date())}" style="max-width:180px;"/>` :
        state.evalMode === 'custom' ? `
          <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
            <input type="date" id="evalCustomStartPick" value="${state.evalCustomStart}" max="${todayStr()}" style="max-width:160px;"/>
            <span style="color:var(--text-faint);">to</span>
            <input type="date" id="evalCustomEndPick" value="${state.evalCustomEnd}" max="${todayStr()}" style="max-width:160px;"/>
          </div>` :
        `<select id="evalYearPick" style="max-width:140px;">${yearOptions()}</select>`}
    </div>
    ${!d ? '' : `
    <div class="card" style="overflow-x:auto;">
      <table class="ledger-table">
        <thead><tr><th>Staff</th><th>Present</th><th>Late</th><th>Absent</th><th>AWOL</th><th>Undertime</th><th>Over break</th><th>Hours</th><th>OT</th><th>Pay</th></tr></thead>
        <tbody>
          ${d.result.length === 0 ? `<tr><td colspan="10" style="text-align:center;color:var(--text-faint);">No active staff.</td></tr>` :
          d.result.map(r => `<tr>
            <td>${escapeHtml(r.user.name)}</td>
            <td style="color:var(--good-soft);">${r.presentDays}</td>
            <td style="color:${r.lateDays > 0 ? 'var(--bad-soft)' : 'var(--text-dim)'};">${r.lateDays}</td>
            <td style="color:${r.absentDays > 0 ? 'var(--bad-soft)' : 'var(--text-dim)'};">${r.absentDays}</td>
            <td style="color:${r.awolDays > 0 ? 'var(--bad-soft)' : 'var(--text-dim)'};">${r.awolDays}</td>
            <td style="color:${r.undertimeDays > 0 ? 'var(--accent-soft)' : 'var(--text-dim)'};">${r.undertimeDays}</td>
            <td style="color:${r.overBreakCount > 0 ? 'var(--bad-soft)' : 'var(--text-dim)'};">${r.overBreakCount}</td>
            <td>${hoursLabel(r.totalHours)}</td>
            <td>${r.otHours > 0 ? hoursLabel(r.otHours) : '—'}</td>
            <td style="font-weight:700;">${fmtMoney(r.grossPay)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div style="color:var(--text-faint);font-size:11.5px;margin-top:10px;">"Present" counts any day with a completed clock-in/out. Absent, AWOL, and undertime come from marks set in the Team tab and don't require a punch that day. "Late" compares clock-in time to that day's scheduled shift start (plus the grace period set in Settings). "Over break" counts breaks/lunches that ran past the limits set in Settings.</div>
    `}
  </div>`;
}

/* ============================= SCHEDULE ============================= */
function renderSchedule() {
  const coverage = state.scheduleCoverage;
  // Show a sensible business-hours window rather than the full 24 — 6am to midnight covers a cafe's day.
  const displayHours = coverage ? coverage.hours.filter(h => h.hour >= 6 && h.hour <= 23) : [];
  const maxCount = Math.max(1, ...displayHours.map(h => h.count));

  return `
  <div class="fade-in">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="scheduleDatePick" value="${state.scheduleDate}"/>
      <div class="font-display" style="font-size:15px;color:var(--text-dim);">${fmtDateLong(state.scheduleDate)}</div>
      ${state.user.role === 'admin' ? `<button id="newShiftBtn" class="btn btn-accent" style="padding:8px 14px;margin-left:auto;">+ Add shift</button>` : ''}
    </div>

    ${state.editShift ? renderShiftForm() : ''}

    ${state.user.role === 'admin' ? `
    <div class="font-display" style="font-size:15px;margin-bottom:8px;">Staff needed per hour</div>
    <div class="card" style="margin-bottom:20px;overflow-x:auto;">
      <div style="display:flex;align-items:flex-end;gap:4px;height:90px;min-width:540px;">
        ${displayHours.map(h => `
          <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;height:100%;">
            ${h.count > 0 ? `<div class="font-mono" style="font-size:10px;color:var(--accent-soft);margin-bottom:2px;">${h.count}</div>` : ''}
            <div style="width:100%;background:${h.count > 0 ? 'var(--accent)' : 'var(--border-soft)'};border-radius:3px 3px 0 0;height:${Math.max(4, (h.count / maxCount) * 60)}px;"></div>
            <div class="font-mono" style="font-size:9px;color:var(--text-faint);margin-top:4px;">${h.hour % 12 === 0 ? 12 : h.hour % 12}${h.hour < 12 ? 'a' : 'p'}</div>
          </div>`).join('')}
      </div>
    </div>` : ''}

    <div class="font-display" style="font-size:15px;margin-bottom:8px;">Shifts</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.scheduleShifts.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No shifts scheduled this day.</div>` :
      state.scheduleShifts.map(sh => `
        <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">
          <div>
            <div style="font-weight:600;">${escapeHtml(sh.user_name)}</div>
            <div class="font-mono" style="font-size:12px;color:var(--text-faint);">${sh.start_time} \u2013 ${sh.end_time}${sh.notes ? ' · ' + escapeHtml(sh.notes) : ''}</div>
          </div>
          ${state.user.role === 'admin' ? `
          <div style="display:flex;gap:8px;">
            <button class="btn btn-ghost edit-shift-btn" data-id="${sh.id}" style="padding:6px 12px;font-size:13px;">Edit</button>
            <button class="btn btn-ghost del-shift-btn" data-id="${sh.id}" style="padding:6px 12px;font-size:13px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
          </div>` : ''}
        </div>`).join('')}
    </div>
  </div>`;
}

function renderShiftForm() {
  const sh = state.editShift;
  const isNew = !sh._existing;
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">${isNew ? 'New shift' : 'Edit shift'}</div>
    <label>Staff</label>
    <select id="sf-user">
      ${state.users.filter(u => u.active).map(u => `<option value="${u.id}" ${sh.userId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}</option>`).join('')}
    </select>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
      <div><label>Start time</label><input id="sf-start" type="time" value="${sh.startTime}"/></div>
      <div><label>End time</label><input id="sf-end" type="time" value="${sh.endTime}"/></div>
    </div>
    <div style="margin-top:12px;"><label>Notes (optional)</label><input id="sf-notes" placeholder="e.g. covering morning rush" value="${escapeHtml(sh.notes || '')}"/></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="sf-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="sf-save" class="btn btn-accent" style="flex:1;">Save shift</button>
    </div>
  </div>`;
}

/* ============================= HR: NOTICES & POLICIES ============================= */
function noticeTypeLabel(t) {
  return { schedule: 'Schedule', contract: 'Contract', warning: 'Warning', penalty: 'Penalty', memo: 'Memo' }[t] || t;
}
function noticeTypeBadgeClass(t) {
  return { schedule: 'badge-accent', contract: 'badge-accent', warning: 'badge-bad', penalty: 'badge-bad', memo: 'badge-good' }[t] || 'badge-accent';
}

function renderHr() {
  const sections = [['notices', 'Notices'], ['policies', 'Store Policy']];
  return `
  <div class="fade-in">
    <div style="display:flex;gap:8px;margin-bottom:16px;">
      ${sections.map(([id, label]) => `<button class="btn ${state.hrSection === id ? 'btn-accent' : 'btn-ghost'} hr-sec-btn" data-sec="${id}">${label}</button>`).join('')}
    </div>
    ${state.hrSection === 'notices' ? renderHrNotices() : renderHrPolicies()}
  </div>`;
}

function noticeEmailStatusInfo(status) {
  return {
    sent: { label: 'Emailed', cls: 'badge-good' },
    partial: { label: 'Partially emailed', cls: 'badge-accent' },
    failed: { label: 'Email failed', cls: 'badge-bad' },
    skipped: { label: 'Not emailed — no address on file', cls: 'badge-accent' },
    not_configured: { label: 'Email not set up', cls: 'badge-accent' },
    not_requested: { label: 'Not emailed', cls: '' },
  }[status] || null;
}

function renderHrNotices() {
  return `
  <div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
      ${state.user.role === 'admin' ? `<button id="newNoticeBtn" class="btn btn-accent" style="padding:8px 14px;">+ Send notice</button>` : ''}
    </div>
    ${state.newNotice ? renderNoticeForm() : ''}
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.notices.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">Nothing here yet.</div>` :
      state.notices.map(n => {
        const needsMyAck = state.user.role !== 'admin' && n.requires_ack && !n.myAcknowledgedAt;
        const emailInfo = noticeEmailStatusInfo(n.email_status);
        return `<div class="card" style="${needsMyAck ? 'border-color:var(--accent);' : ''}">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;">
            <span class="badge ${noticeTypeBadgeClass(n.type)}">${noticeTypeLabel(n.type)}</span>
            <span class="font-mono" style="font-size:11px;color:var(--text-faint);">${fmtDateTimeShort(n.created_at)}</span>
          </div>
          <div class="font-display" style="font-size:15.5px;">${escapeHtml(n.title)}</div>
          <div style="font-size:13.5px;color:var(--text-dim);margin-top:6px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(n.body)}</div>
          ${n.hasAttachment ? `<button class="btn btn-ghost download-attachment-btn" data-id="${n.id}" data-name="${escapeHtml(n.attachment_filename || 'attachment')}" style="margin-top:10px;padding:7px 14px;font-size:12.5px;">📎 ${escapeHtml(n.attachment_filename || 'Download attachment')}</button>` : ''}
          <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:10px;">
            To: ${escapeHtml(n.recipientName)} · from ${escapeHtml(n.issued_by)}
          </div>
          ${state.user.role === 'admin' ? `
            <div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:4px;">
              ${n.requires_ack ? `${n.ackCount}/${n.audienceCount} acknowledged${n.acks.length ? ': ' + n.acks.map(a => escapeHtml(a.userName)).join(', ') : ''}` : 'No acknowledgment required'}
            </div>
            ${emailInfo ? `<span class="badge ${emailInfo.cls}" style="margin-top:8px;" title="${escapeHtml(n.email_error || '')}">${emailInfo.label}</span>` : ''}
            <div>
              <button class="btn btn-ghost del-notice-btn" data-id="${n.id}" style="margin-top:10px;padding:6px 12px;font-size:12.5px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
            </div>
          ` : n.requires_ack ? (
            n.myAcknowledgedAt
              ? `<div class="badge badge-good" style="margin-top:10px;">✓ Acknowledged ${fmtDateTimeShort(n.myAcknowledgedAt)}</div>`
              : `<button class="btn btn-accent ack-notice-btn" data-id="${n.id}" style="margin-top:10px;width:100%;padding:10px;">I acknowledge this</button>`
          ) : ''}
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function renderNoticeForm() {
  const n = state.newNotice;
  const recipient = n.userId ? state.users.find(u => u.id === n.userId) : null;
  const recipientEmail = n.userId ? (recipient ? recipient.email : null) : 'each active staff member with an email on file';
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">Send a notice</div>
    ${!state.emailConfigured ? `<div class="badge badge-bad" style="margin-bottom:12px;">Email isn't set up on this server — notices will still be saved and visible in-app, just not emailed. See README for SMTP setup.</div>` : ''}
    <label>Type</label>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
      ${['schedule', 'contract', 'warning', 'penalty', 'memo'].map(t => `<button class="btn ${n.type === t ? 'btn-accent' : 'btn-ghost'} notice-type-btn" data-type="${t}" style="padding:8px;font-size:12px;">${noticeTypeLabel(t)}</button>`).join('')}
    </div>
    <div style="margin-top:12px;"><label>Recipient</label>
      <select id="nf-recipient">
        <option value="" ${!n.userId ? 'selected' : ''}>All staff</option>
        ${state.users.filter(u => u.active).map(u => `<option value="${u.id}" ${n.userId === u.id ? 'selected' : ''}>${escapeHtml(u.name)}${u.email ? '' : ' (no email)'}</option>`).join('')}
      </select>
      ${n.userId ? (recipientEmail ? `<div style="font-size:11.5px;color:var(--text-faint);margin-top:4px;">Will email: ${escapeHtml(recipientEmail)}</div>` : `<div style="font-size:11.5px;color:var(--bad-soft);margin-top:4px;">No email on file for this person — add one under Team.</div>`) : `<div style="font-size:11.5px;color:var(--text-faint);margin-top:4px;">Will email ${recipientEmail}.</div>`}
    </div>
    <div style="margin-top:12px;"><label>Title</label><input id="nf-title" placeholder="e.g. Written warning — tardiness" value="${escapeHtml(n.title || '')}"/></div>
    <div style="margin-top:12px;"><label>Message</label><textarea id="nf-body" rows="5" placeholder="Details...">${escapeHtml(n.body || '')}</textarea></div>
    <div style="margin-top:12px;"><label>Attach a file (optional)</label><input id="nf-attachment" type="file"/></div>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer;">
      <input type="checkbox" id="nf-requiresack" ${n.requiresAck !== false ? 'checked' : ''} style="width:auto;"/>
      <span style="text-transform:none;letter-spacing:0;color:var(--text-dim);font-size:13px;">Require staff to acknowledge</span>
    </label>
    <label style="display:flex;align-items:center;gap:8px;margin-top:8px;cursor:pointer;">
      <input type="checkbox" id="nf-sendemail" ${state.emailConfigured ? 'checked' : ''} ${state.emailConfigured ? '' : 'disabled'} style="width:auto;"/>
      <span style="text-transform:none;letter-spacing:0;color:var(--text-dim);font-size:13px;">Also email this notice</span>
    </label>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="nf-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="nf-send" class="btn btn-accent" style="flex:1;">Send</button>
    </div>
  </div>`;
}

function renderHrPolicies() {
  return `
  <div>
    <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
      ${state.user.role === 'admin' ? `<button id="newPolicyBtn" class="btn btn-accent" style="padding:8px 14px;">+ New policy</button>` : ''}
    </div>
    ${state.editPolicy ? renderPolicyForm() : ''}
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.policies.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No store policies published yet.</div>` :
      state.policies.map(p => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div class="font-display" style="font-size:15.5px;">${escapeHtml(p.title)}</div>
            ${p.category ? `<span class="tag">${escapeHtml(p.category)}</span>` : ''}
          </div>
          <div style="font-size:13.5px;color:var(--text-dim);margin-top:8px;line-height:1.6;white-space:pre-wrap;">${escapeHtml(p.body)}</div>
          ${state.user.role === 'admin' ? `
            <div style="display:flex;gap:8px;margin-top:12px;">
              <button class="btn btn-ghost edit-policy-btn" data-id="${p.id}" style="padding:6px 12px;font-size:12.5px;">Edit</button>
              <button class="btn btn-ghost del-policy-btn" data-id="${p.id}" style="padding:6px 12px;font-size:12.5px;color:var(--bad-soft);border-color:rgba(181,72,42,0.4);">Delete</button>
            </div>` : ''}
        </div>`).join('')}
    </div>
  </div>`;
}

function renderPolicyForm() {
  const p = state.editPolicy;
  const isNew = !p._existing;
  return `
  <div class="card fade-in" style="margin-bottom:16px;border-color:var(--accent);">
    <div class="font-display" style="font-size:16px;margin-bottom:12px;">${isNew ? 'New policy' : 'Edit policy'}</div>
    <label>Title</label><input id="pf2-title" placeholder="e.g. Attendance Policy" value="${escapeHtml(p.title || '')}"/>
    <div style="margin-top:12px;"><label>Category (optional)</label><input id="pf2-category" placeholder="e.g. General, Safety, Conduct" value="${escapeHtml(p.category || '')}"/></div>
    <div style="margin-top:12px;"><label>Content</label><textarea id="pf2-body" rows="6" placeholder="Policy text...">${escapeHtml(p.body || '')}</textarea></div>
    <div style="display:flex;gap:10px;margin-top:16px;">
      <button id="pf2-cancel" class="btn btn-ghost" style="flex:1;">Cancel</button>
      <button id="pf2-save" class="btn btn-accent" style="flex:1;">Save policy</button>
    </div>
  </div>`;
}

/* ============================= STAFF REQUESTS ============================= */
function renderRequests() {
  const sections = [['availability', 'Availability'], ['leave', 'Leave'], ['feedback', 'Feedback']];
  if (state.user.role === 'admin') sections.push(['exceptions', 'Exceptions']);
  return `
  <div class="fade-in">
    <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
      ${sections.map(([id, label]) => `<button class="btn ${state.requestsSection === id ? 'btn-accent' : 'btn-ghost'} req-sec-btn" data-sec="${id}">${label}</button>`).join('')}
    </div>
    ${state.requestsSection === 'availability' ? renderAvailabilitySection() :
      state.requestsSection === 'leave' ? renderLeaveSection() :
      state.requestsSection === 'exceptions' ? renderExceptionsSection() :
      renderFeedbackSection()}
  </div>`;
}

function weekRangeLabel(mondayISO) {
  if (!mondayISO) return '';
  const start = new Date(mondayISO + 'T00:00:00');
  const end = new Date(start); end.setDate(end.getDate() + 6);
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}

function renderAvailabilitySection() {
  const dayLabels = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  if (state.user.role === 'admin') {
    return `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">
      <input type="date" id="availWeekPick" value="${state.availabilityWeek}"/>
      <div class="font-display" style="font-size:15px;color:var(--text-dim);">Week of ${weekRangeLabel(state.availabilityWeek)}</div>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.allAvailability.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No one has submitted availability for this week yet.</div>` :
      state.allAvailability.map(a => `
        <div class="card">
          <div style="font-weight:600;margin-bottom:8px;">${escapeHtml(a.user_name)}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">
            ${Object.keys(dayLabels).map(d => {
              const day = a.days[d];
              const available = day && day.available;
              return `<span class="badge ${available ? 'badge-good' : 'badge-bad'}" style="font-size:10.5px;">${dayLabels[d]}</span>`;
            }).join('')}
          </div>
          ${a.notes ? `<div style="font-size:13px;color:var(--text-dim);margin-top:8px;">${escapeHtml(a.notes)}</div>` : ''}
        </div>`).join('')}
    </div>`;
  }

  return `
    <div class="card">
      <div class="font-display" style="font-size:16px;margin-bottom:4px;">Week of ${weekRangeLabel(state.availabilityWeek)}</div>
      <div style="color:var(--text-faint);font-size:12.5px;margin-bottom:14px;">${state.myAvailability ? 'You already submitted — you can update it below.' : "Let us know which days you're free to work next week."}</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${Object.entries({ mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }).map(([d, label]) => {
          const available = state.availDaysDraft[d] ? state.availDaysDraft[d].available : true;
          return `<div style="display:flex;justify-content:space-between;align-items:center;">
            <span style="font-size:13.5px;">${label}</span>
            <div style="display:flex;gap:6px;">
              <button class="btn ${available ? 'btn-good' : 'btn-ghost'} avail-day-btn" data-day="${d}" data-val="true" style="padding:6px 12px;font-size:12px;">Available</button>
              <button class="btn ${!available ? 'btn-bad' : 'btn-ghost'} avail-day-btn" data-day="${d}" data-val="false" style="padding:6px 12px;font-size:12px;">Can't</button>
            </div>
          </div>`;
        }).join('')}
      </div>
      <div style="margin-top:14px;"><label>Notes (optional)</label><textarea id="availNotesField" rows="2" placeholder="e.g. Tuesday I have a doctor's appointment in the morning">${escapeHtml(state.availNotesDraft)}</textarea></div>
      <button id="submitAvailBtn" class="btn btn-accent btn-block" style="margin-top:14px;">${state.myAvailability ? 'Update' : 'Submit'} availability</button>
    </div>`;
}

function renderLeaveSection() {
  const statusBadge = s => ({ pending: 'badge-accent', approved: 'badge-good', denied: 'badge-bad' }[s] || '');
  if (state.user.role === 'admin') {
    const filters = [['', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied']];
    return `
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      ${filters.map(([id, label]) => `<button class="btn ${state.leaveFilter === id ? 'btn-accent' : 'btn-ghost'} leave-filter-btn" data-status="${id}" style="padding:7px 12px;font-size:12.5px;">${label}</button>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.allLeaveRequests.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No leave requests here.</div>` :
      state.allLeaveRequests.map(r => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="font-weight:600;">${escapeHtml(r.user_name)}</div>
              <div class="font-mono" style="font-size:12px;color:var(--text-faint);margin-top:2px;">${fmtDateLong(r.start_date)}${r.start_date !== r.end_date ? ' → ' + fmtDateLong(r.end_date) : ''}</div>
              ${r.reason ? `<div style="font-size:13px;color:var(--text-dim);margin-top:6px;">${escapeHtml(r.reason)}</div>` : ''}
              ${r.notes ? `<div style="font-size:12.5px;color:var(--text-faint);margin-top:3px;">${escapeHtml(r.notes)}</div>` : ''}
            </div>
            <span class="badge ${statusBadge(r.status)}">${r.status}</span>
          </div>
          ${r.status === 'pending' ? `
            <div style="display:flex;gap:8px;margin-top:12px;">
              <button class="btn btn-good leave-review-btn" data-id="${r.id}" data-status="approved" style="flex:1;padding:8px;font-size:12.5px;">Approve</button>
              <button class="btn btn-bad leave-review-btn" data-id="${r.id}" data-status="denied" style="flex:1;padding:8px;font-size:12.5px;">Deny</button>
            </div>` : r.reviewed_by ? `<div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:10px;">reviewed by ${escapeHtml(r.reviewed_by)}</div>` : ''}
        </div>`).join('')}
    </div>`;
  }

  const f = state.leaveForm;
  return `
    <div class="card" style="margin-bottom:18px;">
      <div class="font-display" style="font-size:16px;margin-bottom:12px;">Request time off</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div><label>Start date</label><input id="leaveStartField" type="date" value="${f.startDate}"/></div>
        <div><label>End date</label><input id="leaveEndField" type="date" value="${f.endDate}"/></div>
      </div>
      <div style="margin-top:12px;"><label>Reason</label><input id="leaveReasonField" placeholder="e.g. Family event" value="${escapeHtml(f.reason)}"/></div>
      <div style="margin-top:12px;"><label>Notes (optional)</label><textarea id="leaveNotesField" rows="2">${escapeHtml(f.notes)}</textarea></div>
      <button id="submitLeaveBtn" class="btn btn-accent btn-block" style="margin-top:14px;">Submit request</button>
    </div>
    <div class="font-display" style="font-size:15px;margin-bottom:8px;">My requests</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.myLeaveRequests.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">No requests yet.</div>` :
      state.myLeaveRequests.map(r => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div class="font-mono" style="font-size:12px;color:var(--text-faint);">${fmtDateLong(r.start_date)}${r.start_date !== r.end_date ? ' → ' + fmtDateLong(r.end_date) : ''}</div>
              ${r.reason ? `<div style="font-size:13px;margin-top:4px;">${escapeHtml(r.reason)}</div>` : ''}
              ${r.admin_notes ? `<div style="font-size:12.5px;color:var(--text-faint);margin-top:4px;">Admin: ${escapeHtml(r.admin_notes)}</div>` : ''}
            </div>
            <span class="badge ${statusBadge(r.status)}">${r.status}</span>
          </div>
        </div>`).join('')}
    </div>`;
}

function renderExceptionsSection() {
  const filters = [['pending', 'Pending'], ['approved', 'Approved'], ['denied', 'Denied'], ['', 'All']];
  const typeLabel = t => t === 'no_shift' ? 'No shift scheduled' : 'Late arrival';
  return `
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
      ${filters.map(([id, label]) => `<button class="btn ${state.exceptionFilter === id ? 'btn-accent' : 'btn-ghost'} exception-filter-btn" data-status="${id}" style="padding:7px 12px;font-size:12.5px;">${label}</button>`).join('')}
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.allExceptions.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">Nothing here.</div>` :
      state.allExceptions.map(e => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;">
            <div>
              <div style="font-weight:600;">${escapeHtml(e.user_name)}</div>
              <div class="font-mono" style="font-size:12px;color:var(--text-faint);margin-top:2px;">${fmtDateLong(e.date)} · ${typeLabel(e.type)}${e.minutes_late != null ? ` (${e.minutes_late} min, scheduled ${e.scheduled_start})` : ''}</div>
              ${e.reason ? `<div style="font-size:13px;color:var(--text-dim);margin-top:8px;">"${escapeHtml(e.reason)}"</div>` : `<div style="font-size:12.5px;color:var(--text-faint);margin-top:8px;">No reason given yet.</div>`}
              ${e.admin_notes ? `<div style="font-size:12px;color:var(--text-faint);margin-top:4px;">Admin: ${escapeHtml(e.admin_notes)}</div>` : ''}
            </div>
            <span class="badge ${e.status === 'approved' ? 'badge-good' : e.status === 'denied' ? 'badge-bad' : 'badge-accent'}">${e.status}</span>
          </div>
          ${e.status === 'pending' ? `
            <div style="display:flex;gap:8px;margin-top:12px;">
              <button class="btn btn-good exception-review-btn" data-id="${e.id}" data-status="approved" style="flex:1;padding:8px;font-size:12.5px;">Approve</button>
              <button class="btn btn-bad exception-review-btn" data-id="${e.id}" data-status="denied" style="flex:1;padding:8px;font-size:12.5px;">Deny</button>
            </div>` : e.reviewed_by ? `<div class="font-mono" style="font-size:11px;color:var(--text-faint);margin-top:10px;">reviewed by ${escapeHtml(e.reviewed_by)}</div>` : ''}
        </div>`).join('')}
    </div>`;
}

function renderFeedbackSection() {
  const catBadge = { feedback: 'badge-accent', suggestion: 'badge-good', complaint: 'badge-bad' };
  if (state.user.role === 'admin') {
    return `
    <div style="display:flex;flex-direction:column;gap:10px;">
      ${state.allFeedback.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">Nothing submitted yet.</div>` :
      state.allFeedback.map(f => {
        const isReplying = state.replyingFeedbackId === f.id;
        return `<div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:8px;">
            <span class="badge ${catBadge[f.category] || ''}">${f.category}</span>
            <span class="font-mono" style="font-size:11px;color:var(--text-faint);">${fmtDateTimeShort(f.submitted_at)}</span>
          </div>
          <div style="font-weight:600;font-size:13.5px;">${escapeHtml(f.user_name)}</div>
          <div style="font-size:13.5px;color:var(--text-dim);margin-top:6px;line-height:1.5;white-space:pre-wrap;">${escapeHtml(f.message)}</div>
          ${f.admin_reply && !isReplying ? `
            <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-soft);">
              <div class="font-mono" style="font-size:11px;color:var(--accent-soft);margin-bottom:3px;">Reply from ${escapeHtml(f.replied_by)}</div>
              <div style="font-size:13px;color:var(--text-dim);white-space:pre-wrap;">${escapeHtml(f.admin_reply)}</div>
              <button class="btn btn-ghost edit-feedback-reply-btn" data-id="${f.id}" style="margin-top:8px;padding:5px 10px;font-size:11.5px;">Edit reply</button>
            </div>
          ` : isReplying ? `
            <div style="margin-top:10px;">
              <textarea id="feedbackReply-${f.id}" rows="3" placeholder="Write a reply...">${escapeHtml(state.feedbackReplyDraft)}</textarea>
              <div style="display:flex;gap:8px;margin-top:8px;">
                <button class="btn btn-ghost cancel-feedback-reply-btn" style="flex:1;padding:7px;font-size:12px;">Cancel</button>
                <button class="btn btn-accent send-feedback-reply-btn" data-id="${f.id}" style="flex:1;padding:7px;font-size:12px;">Send reply</button>
              </div>
            </div>
          ` : `<button class="btn btn-ghost start-feedback-reply-btn" data-id="${f.id}" style="margin-top:10px;padding:6px 12px;font-size:12px;">Reply</button>`}
        </div>`;
      }).join('')}
    </div>`;
  }

  return `
    <div class="card" style="margin-bottom:18px;">
      <div class="font-display" style="font-size:16px;margin-bottom:12px;">Send feedback or a suggestion</div>
      <label>Type</label>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">
        ${[['feedback', 'Feedback'], ['suggestion', 'Suggestion'], ['complaint', 'Complaint']].map(([id, label]) =>
          `<button class="btn ${state.feedbackCategory === id ? 'btn-accent' : 'btn-ghost'} feedback-cat-btn" data-cat="${id}" style="padding:8px;font-size:12.5px;">${label}</button>`
        ).join('')}
      </div>
      <div style="margin-top:12px;"><label>Message</label><textarea id="feedbackMessageField" rows="5" placeholder="Say whatever's on your mind — only admin sees this.">${escapeHtml(state.feedbackMessage)}</textarea></div>
      <button id="submitFeedbackBtn" class="btn btn-accent btn-block" style="margin-top:14px;">Send</button>
    </div>
    <div class="font-display" style="font-size:15px;margin-bottom:8px;">My feedback</div>
    <div style="display:flex;flex-direction:column;gap:8px;">
      ${state.myFeedback.length === 0 ? `<div class="card" style="color:var(--text-faint);text-align:center;">Nothing sent yet.</div>` :
      state.myFeedback.map(f => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:6px;">
            <span class="badge ${catBadge[f.category] || ''}">${f.category}</span>
            <span class="badge ${f.status === 'replied' ? 'badge-good' : ''}">${f.status === 'replied' ? 'Replied' : 'Pending'}</span>
          </div>
          <div style="font-size:13.5px;color:var(--text-dim);line-height:1.5;white-space:pre-wrap;">${escapeHtml(f.message)}</div>
          ${f.admin_reply ? `
            <div style="margin-top:10px;padding-top:10px;border-top:1px dashed var(--border-soft);">
              <div class="font-mono" style="font-size:11px;color:var(--accent-soft);margin-bottom:3px;">Reply from ${escapeHtml(f.replied_by)}</div>
              <div style="font-size:13px;color:var(--text-dim);white-space:pre-wrap;">${escapeHtml(f.admin_reply)}</div>
            </div>` : ''}
        </div>`).join('')}
    </div>`;
}

/* ============================= EVENT WIRING ============================= */
function attachShellHandlers() {
  document.getElementById('logoutBtn')?.addEventListener('click', logout);

  /* ---- In-app Quick Clock In/Out modal ---- */
  const openInlineKiosk = () => {
    state.showInlineKiosk = true;
    kioskReset();
    render();
  };
  document.getElementById('openInlineKioskBtn')?.addEventListener('click', openInlineKiosk);
  document.getElementById('openInlineKioskBtn2')?.addEventListener('click', openInlineKiosk);
  document.getElementById('ttClockInBtn')?.addEventListener('click', openInlineKiosk);
  document.getElementById('ttClockOutBtn')?.addEventListener('click', openInlineKiosk);
  document.getElementById('closeInlineKioskBtn')?.addEventListener('click', () => { state.showInlineKiosk = false; render(); });
  document.querySelectorAll('.kiosk-digit').forEach(b => b.addEventListener('click', () => kioskPressDigit(b.getAttribute('data-d'))));
  document.getElementById('kioskBack')?.addEventListener('click', kioskBackspace);
  document.getElementById('kioskEmailField')?.addEventListener('input', e => { state.kioskEmailInput = e.target.value; });
  document.getElementById('kioskConfirmEmailField')?.addEventListener('input', e => { state.kioskEmailInput = e.target.value; });
  document.getElementById('kioskEnter')?.addEventListener('click', submitKioskLookup);
  document.querySelectorAll('.kiosk-action-btn').forEach(b => b.addEventListener('click', () => {
    const action = b.getAttribute('data-action');
    if (action === 'end_break') requestEndBreakConfirm();
    else performKioskAction(action);
  }));
  document.querySelector('.kiosk-cancel-btn')?.addEventListener('click', cancelKioskLookup);
  document.querySelectorAll('.kiosk-confirm-digit').forEach(b => b.addEventListener('click', () => kioskPressDigit(b.getAttribute('data-d'))));
  document.getElementById('kioskConfirmBack')?.addEventListener('click', kioskBackspace);
  document.getElementById('kioskConfirmEnter')?.addEventListener('click', confirmEndBreakAction);
  document.querySelector('.kiosk-confirm-cancel-btn')?.addEventListener('click', cancelEndBreakConfirm);
  document.getElementById('kioskReasonField')?.addEventListener('input', e => { state.kioskReasonInput = e.target.value; });
  document.getElementById('submitKioskReasonBtn')?.addEventListener('click', submitKioskExceptionReason);
  document.getElementById('skipKioskReasonBtn')?.addEventListener('click', skipKioskExceptionReason);
  document.querySelectorAll('.roster-action-btn').forEach(b => b.addEventListener('click', () => {
    requestKioskRowAction(
      { id: Number(b.getAttribute('data-user-id')), name: b.getAttribute('data-user-name') },
      b.getAttribute('data-action'),
      b.getAttribute('data-break-type') || null
    );
  }));

  document.querySelectorAll('.app-switch-btn').forEach(b => b.addEventListener('click', () => switchApp(b.getAttribute('data-app'))));
  document.querySelectorAll('.navbtn').forEach(b => b.addEventListener('click', () => switchTab(b.getAttribute('data-tab'))));
  document.querySelectorAll('.goto-tab').forEach(b => b.addEventListener('click', () => switchTab(b.getAttribute('data-tab'))));

  document.getElementById('modalCancel')?.addEventListener('click', () => { state.confirmModal = null; state.resetTypeInput = ''; state.reasonInput = ''; state.amountInput = ''; render(); });
  document.getElementById('modalConfirm')?.addEventListener('click', () => { if (state.confirmModal) state.confirmModal.onConfirm(); });
  document.getElementById('modalTypeInput')?.addEventListener('input', e => { state.resetTypeInput = e.target.value; render(); });
  document.getElementById('modalReasonInput')?.addEventListener('input', e => { state.reasonInput = e.target.value; render(); });
  document.getElementById('modalAmountInput')?.addEventListener('input', e => { state.amountInput = e.target.value; });

  // ADD
  document.getElementById('af-product')?.addEventListener('change', e => { state.formProductId = e.target.value; });
  document.getElementById('af-qty')?.addEventListener('input', e => { state.formQty = e.target.value; });
  document.getElementById('af-reason')?.addEventListener('input', e => { state.formReason = e.target.value; });
  document.getElementById('af-submit')?.addEventListener('click', () => {
    state.formProductId = document.getElementById('af-product').value;
    state.formQty = document.getElementById('af-qty').value;
    state.formReason = document.getElementById('af-reason').value;
    addStockEntry();
  });

  // DISCARD
  document.getElementById('df-product')?.addEventListener('change', e => { state.formProductId = e.target.value; });
  document.getElementById('df-qty')?.addEventListener('input', e => { state.formQty = e.target.value; });
  document.getElementById('df-reason')?.addEventListener('change', e => { state.formReason = e.target.value; });
  document.getElementById('df-submit')?.addEventListener('click', () => {
    state.formProductId = document.getElementById('df-product').value;
    state.formQty = document.getElementById('df-qty').value;
    state.formReason = document.getElementById('df-reason').value;
    discardStockEntry();
  });

  // COUNT
  document.querySelectorAll('.count-input').forEach(inp => inp.addEventListener('input', e => { state.countInputs[inp.getAttribute('data-pid')] = e.target.value; }));
  document.querySelectorAll('.count-save').forEach(btn => btn.addEventListener('click', () => {
    const pid = btn.getAttribute('data-pid');
    const val = document.querySelector(`.count-input[data-pid="${pid}"]`).value;
    saveActualCount(pid, val);
  }));

  // REPORTS
  document.querySelectorAll('.report-mode-btn').forEach(b => b.addEventListener('click', async () => {
    state.reportMode = b.getAttribute('data-mode');
    state.loadingTab = true; render();
    await loadReportData();
    state.loadingTab = false; render();
  }));
  document.getElementById('dailyDatePick')?.addEventListener('change', async e => {
    state.reportDate = e.target.value;
    state.loadingTab = true; render();
    await loadReportData();
    state.loadingTab = false; render();
  });
  document.getElementById('comparisonDatePick')?.addEventListener('change', async e => {
    state.reportDate = e.target.value;
    state.loadingTab = true; render();
    await loadReportData();
    state.loadingTab = false; render();
  });
  document.getElementById('monthlyPick')?.addEventListener('change', async e => {
    state.reportMonth = e.target.value;
    state.loadingTab = true; render();
    await loadReportData();
    state.loadingTab = false; render();
  });
  document.getElementById('yearPick')?.addEventListener('change', async e => {
    state.reportYear = e.target.value;
    state.loadingTab = true; render();
    await loadReportData();
    state.loadingTab = false; render();
  });

  // MOVERS
  document.querySelectorAll('.movers-period-btn').forEach(b => b.addEventListener('click', async () => {
    state.moversPeriod = Number(b.getAttribute('data-period'));
    state.loadingTab = true; render();
    state.moversData = await api('/api/ledger/movers?days=' + state.moversPeriod);
    state.loadingTab = false; render();
  }));

  // ADMIN nav
  document.querySelectorAll('.admin-sec-btn').forEach(b => b.addEventListener('click', async () => {
    state.adminSection = b.getAttribute('data-sec');
    state.editProduct = null; state.editUser = null;
    state.loadingTab = true; render();
    await loadAdminSectionData(state.adminSection);
    state.loadingTab = false; render();
  }));

  // ADMIN products
  document.getElementById('newProductBtn')?.addEventListener('click', () => {
    state.editProduct = { id: null, name: '', category: '', unit: 'pcs', initial_stock: 0, reorder_level: '', _existing: false };
    render();
  });
  document.querySelectorAll('.edit-product-btn').forEach(b => b.addEventListener('click', () => {
    const p = state.products.find(x => x.id === b.getAttribute('data-id'));
    state.editProduct = Object.assign({}, p, { _existing: true });
    render();
  }));
  document.querySelectorAll('.del-product-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const p = state.products.find(x => x.id === id);
    state.confirmModal = {
      title: 'Delete product?', body: `This removes <b>${escapeHtml(p.name)}</b> from the product list. Past ledger entries stay in the log.`,
      confirmLabel: 'Delete', danger: true, onConfirm: () => deleteProductAction(id)
    };
    render();
  }));
  document.getElementById('pf-cancel')?.addEventListener('click', () => { state.editProduct = null; render(); });
  document.getElementById('pf-unit-select')?.addEventListener('change', e => {
    const customInput = document.getElementById('pf-unit-custom');
    if (e.target.value === '__custom__') { customInput.style.display = 'block'; customInput.focus(); }
    else { customInput.style.display = 'none'; }
  });
  document.getElementById('pf-save')?.addEventListener('click', () => {
    const name = document.getElementById('pf-name').value.trim();
    if (!name) { toast('Product needs a name.', 'bad'); return; }
    const unitSelectVal = document.getElementById('pf-unit-select').value;
    const unit = unitSelectVal === '__custom__'
      ? document.getElementById('pf-unit-custom').value.trim()
      : unitSelectVal;
    if (!unit) { toast('Enter a custom unit name.', 'bad'); return; }
    const payload = {
      name,
      category: document.getElementById('pf-category').value.trim(),
      unit,
      initialStock: Number(document.getElementById('pf-initial').value) || 0,
      reorderLevel: document.getElementById('pf-reorder').value,
      barcode: document.getElementById('pf-barcode').value.trim()
    };
    saveProductAction(payload, state.editProduct._existing ? state.editProduct.id : null);
  });

  // ADMIN team
  document.getElementById('teamSortSelect')?.addEventListener('change', e => { state.teamSortBy = e.target.value; render(); });
  document.getElementById('teamRoleFilter')?.addEventListener('change', e => { state.teamFilterRole = e.target.value; render(); });
  document.getElementById('teamStatusFilter')?.addEventListener('change', e => { state.teamFilterStatus = e.target.value; render(); });
  document.getElementById('newUserBtn')?.addEventListener('click', () => {
    state.editUser = { id: null, name: '', role: 'staff', active: 1, _existing: false, manager_permissions_obj: {} };
    state.showHrDetails = false; state.staffDocuments = {};
    render();
  });
  document.querySelectorAll('.edit-user-btn').forEach(b => b.addEventListener('click', () => {
    const u = state.users.find(x => x.id === Number(b.getAttribute('data-id')));
    let permsObj = {};
    try { permsObj = u.manager_permissions ? JSON.parse(u.manager_permissions) : {}; } catch (e) { permsObj = {}; }
    state.editUser = Object.assign({}, u, { _existing: true, manager_permissions_obj: permsObj });
    state.showHrDetails = false; state.staffDocuments = {};
    render();
  }));
  document.querySelectorAll('.toggle-active-btn').forEach(b => b.addEventListener('click', () => {
    toggleActiveAction(Number(b.getAttribute('data-id')), b.getAttribute('data-active') === '1');
  }));
  document.querySelectorAll('.del-user-btn').forEach(b => b.addEventListener('click', () => {
    const id = Number(b.getAttribute('data-id'));
    const u = state.users.find(x => x.id === id);
    state.confirmModal = {
      title: 'Remove team member?', body: `Removes <b>${escapeHtml(u.name)}</b> if they have no activity history — otherwise they're deactivated instead, so past records stay correctly attributed to them. Either way, they can no longer log in.`,
      confirmLabel: 'Remove', danger: true, onConfirm: () => deleteUserAction(id)
    };
    render();
  }));
  document.getElementById('uf-cancel')?.addEventListener('click', () => { state.editUser = null; render(); });
  document.getElementById('uf-role')?.addEventListener('change', e => {
    state.editUser.role = e.target.value;
    if (!state.editUser.manager_permissions_obj) state.editUser.manager_permissions_obj = {};
    render();
  });
  document.querySelectorAll('.uf-permission-check').forEach(cb => cb.addEventListener('change', e => {
    if (!state.editUser.manager_permissions_obj) state.editUser.manager_permissions_obj = {};
    state.editUser.manager_permissions_obj[e.target.getAttribute('data-key')] = e.target.checked;
  }));
  document.getElementById('uf-save')?.addEventListener('click', () => {
    const name = document.getElementById('uf-name').value.trim();
    if (!name) { toast('Name is required.', 'bad'); return; }
    const role = document.getElementById('uf-role').value;
    const pin = document.getElementById('uf-pin').value.trim();
    const isNew = !state.editUser._existing;
    if (isNew && !pin) { toast('Set a PIN for the new team member.', 'bad'); return; }
    const payload = { name, role, hourlyRate: Number(document.getElementById('uf-rate').value) || 0, email: document.getElementById('uf-email').value.trim(), position: document.getElementById('uf-position').value };
    if (pin) payload.pin = pin;
    if (!isNew) payload.active = document.getElementById('uf-active').value === '1';
    if (role === 'manager') payload.managerPermissions = state.editUser.manager_permissions_obj || {};
    if (state.showHrDetails) {
      const hrFieldIds = {
        address: 'uf-address', contact_number: 'uf-contact', emergency_contact: 'uf-emergency',
        date_of_birth: 'uf-dob', tin: 'uf-tin', sss_number: 'uf-sss', philhealth_number: 'uf-philhealth',
        pagibig_number: 'uf-pagibig', education: 'uf-education', date_hired: 'uf-datehired',
        termination_date: 'uf-termdate', hr_notes: 'uf-hrnotes'
      };
      Object.entries(hrFieldIds).forEach(([field, id]) => {
        const el = document.getElementById(id);
        if (el) payload[field] = el.value.trim();
      });
    }
    saveUserAction(payload, isNew ? null : state.editUser.id);
  });
  document.getElementById('toggleHrDetailsBtn')?.addEventListener('click', async () => {
    state.showHrDetails = !state.showHrDetails;
    if (state.showHrDetails && state.editUser._existing) {
      try { state.staffDocuments = await api('/api/staff-documents/' + state.editUser.id); } catch (e) { state.staffDocuments = {}; }
    }
    render();
  });
  document.querySelectorAll('.staff-doc-upload-btn').forEach(b => b.addEventListener('click', async () => {
    const type = b.getAttribute('data-type');
    const userId = b.getAttribute('data-user');
    const fileInput = document.querySelector(`.staff-doc-file[data-type="${type}"][data-user="${userId}"]`);
    if (!fileInput.files[0]) { toast('Choose a file first.', 'bad'); return; }
    const fd = new FormData();
    fd.append('file', fileInput.files[0]);
    try {
      await api(`/api/staff-documents/${userId}/${type}`, { method: 'POST', body: fd });
      toast('Uploaded.', 'good');
      state.staffDocuments = await api('/api/staff-documents/' + userId);
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }));
  document.querySelectorAll('.staff-doc-view-btn').forEach(b => b.addEventListener('click', async () => {
    const type = b.getAttribute('data-type');
    const userId = b.getAttribute('data-user');
    try {
      const res = await fetch(`/api/staff-documents/${userId}/${type}/file`, { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!res.ok) throw new Error('Could not load document');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
    } catch (e) { toast(e.message, 'bad'); }
  }));
  document.querySelectorAll('.staff-doc-remove-btn').forEach(b => b.addEventListener('click', async () => {
    const type = b.getAttribute('data-type');
    const userId = b.getAttribute('data-user');
    try {
      await api(`/api/staff-documents/${userId}/${type}`, { method: 'DELETE' });
      toast('Removed.', 'accent');
      state.staffDocuments = await api('/api/staff-documents/' + userId);
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }));

  // ADMIN entry log
  document.getElementById('logDatePick')?.addEventListener('change', async e => {
    state.editDate = e.target.value;
    state.loadingTab = true; render();
    state.todayEntries = await api('/api/entries?date=' + state.editDate);
    state.loadingTab = false; render();
  });
  document.querySelectorAll('.log-qty-save').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const val = document.querySelector(`.log-qty-edit[data-id="${id}"]`).value;
    updateEntryAction(id, { qty: Number(val) || 0 });
  }));
  document.querySelectorAll('.log-del').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.confirmModal = {
      title: 'Delete entry?', body: 'This permanently removes this movement from the ledger.',
      confirmLabel: 'Delete', danger: true, onConfirm: () => deleteEntryAction(id)
    };
    render();
  }));

  // ADMIN settings
  document.getElementById('auditStartPick')?.addEventListener('change', async e => {
    state.auditStart = e.target.value;
    state.loadingTab = true; render();
    await loadAuditLog();
    state.loadingTab = false; render();
  });
  document.getElementById('auditEndPick')?.addEventListener('change', async e => {
    state.auditEnd = e.target.value;
    state.loadingTab = true; render();
    await loadAuditLog();
    state.loadingTab = false; render();
  });
  document.getElementById('auditActionFilter')?.addEventListener('change', async e => {
    state.auditFilterAction = e.target.value;
    state.loadingTab = true; render();
    await loadAuditLog();
    state.loadingTab = false; render();
  });

  document.getElementById('editAttentionBtn')?.addEventListener('click', () => {
    state.editingAttentionNote = true;
    state.attentionNoteDraft = state.settings.attention_note || '';
    render();
  });
  document.getElementById('cancelAttentionBtn')?.addEventListener('click', () => {
    state.editingAttentionNote = false;
    render();
  });
  document.getElementById('saveAttentionBtn')?.addEventListener('click', async () => {
    const note = document.getElementById('attentionNoteInput').value;
    try {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ attention_note: note }) });
      state.settings.attention_note = note;
      state.editingAttentionNote = false;
      toast('Attention note updated.', 'good');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  });

  document.getElementById('set-save')?.addEventListener('click', () => {
    saveSettingsAction({
      cafe_name: document.getElementById('set-cafename').value.trim() || 'Cafe',
      break_limit_minutes: Number(document.getElementById('set-breaklimit').value) || 15,
      lunch_limit_minutes: Number(document.getElementById('set-lunchlimit').value) || 60,
      late_grace_minutes: Number(document.getElementById('set-lategrace').value) || 0,
      notice_reply_to: document.getElementById('set-replyto').value.trim(),
      business_name: document.getElementById('set-bizname').value.trim(),
      business_address: document.getElementById('set-bizaddress').value.trim(),
      business_tin: document.getElementById('set-biztin').value.trim(),
      vat_registered: document.getElementById('set-vatstatus').value,
      invoice_prefix: document.getElementById('set-invprefix').value.trim() || 'OR',
      facebook_page: document.getElementById('set-fbpage').value.trim(),
      receipt_footer_note: document.getElementById('set-footernote').value.trim(),
      theme: state.settings.theme || 'dark'
    });
  });
  document.getElementById('previewReceiptBtn')?.addEventListener('click', () => {
    const biz = {
      business_name: document.getElementById('set-bizname').value.trim() || state.cafeName,
      business_address: document.getElementById('set-bizaddress').value.trim(),
      business_tin: document.getElementById('set-biztin').value.trim(),
      vat_registered: document.getElementById('set-vatstatus').value,
      facebook_page: document.getElementById('set-fbpage').value.trim(),
      receipt_footer_note: document.getElementById('set-footernote').value.trim()
    };
    const prefix = document.getElementById('set-invprefix').value.trim() || 'OR';
    const sampleItems = [
      { name: 'Cappuccino', price: 150, qty: 2 },
      { name: 'Blueberry Muffin', price: 90, qty: 1 }
    ];
    const subtotal = sampleItems.reduce((s, i) => s + i.price * i.qty, 0);
    const vatRate = 0.12;
    const vatExclusive = subtotal / (1 + vatRate);
    const vatAmount = subtotal - vatExclusive;
    const mockSale = {
      invoice_no: prefix + '-000001',
      created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
      items: sampleItems,
      subtotal, vat_amount: vatAmount, discount_amount: 0, total: subtotal,
      payment_method: 'Cash', order_type: 'dine_in', cashier_name: state.user.name
    };
    printReceipt(mockSale, biz, true);
  });

  document.querySelectorAll('.theme-select-btn').forEach(b => b.addEventListener('click', () => {
    const theme = b.getAttribute('data-theme');
    state.settings.theme = theme;
    applyTheme(theme);
    render();
  }));

  document.getElementById('uploadLogoBtn')?.addEventListener('click', async () => {
    const fileInput = document.getElementById('set-logo-file');
    if (!fileInput.files[0]) { toast('Choose an image file first.', 'bad'); return; }
    const fd = new FormData();
    fd.append('logo', fileInput.files[0]);
    try {
      await api('/api/admin/logo', { method: 'POST', body: fd });
      toast('Logo updated.', 'good');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  });
  document.getElementById('resetLogoBtn')?.addEventListener('click', async () => {
    try {
      await api('/api/admin/logo', { method: 'DELETE' });
      toast('Logo reset to default.', 'accent');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  });

  document.getElementById('downloadBackupBtn')?.addEventListener('click', async e => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/backup', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!res.ok) throw new Error('Backup download failed');
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'stock-ledger-backup.db';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Backup downloaded.', 'good');
    } catch (err) { toast('Could not download backup.', 'bad'); }
  });

  document.getElementById('downloadExcelBtn')?.addEventListener('click', async e => {
    e.preventDefault();
    try {
      const res = await fetch('/api/admin/export-excel', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!res.ok) throw new Error('Export failed');
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? match[1] : 'stock-ledger-export.xlsx';
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Excel file downloaded.', 'good');
    } catch (err) { toast('Could not download Excel export.', 'bad'); }
  });

  // ADMIN danger
  document.getElementById('resetTodayBtn')?.addEventListener('click', () => {
    state.confirmModal = {
      title: "Clear today's entries?", body: "All stock added, discarded, and counted for today will be erased. This can't be undone.",
      confirmLabel: 'Clear today', danger: true, onConfirm: resetTodayAction
    };
    render();
  });
  document.getElementById('resetAllBtn')?.addEventListener('click', () => {
    state.resetTypeInput = '';
    state.confirmModal = {
      title: 'Reset all inventory data?', body: "Every day's ledger — every add, discard, and count — will be permanently erased. Products and team accounts are kept. This can't be undone.",
      confirmLabel: 'Reset everything', danger: true, requireType: 'RESET', onConfirm: resetAllAction
    };
    render();
  });

  /* ---- POS: Register ---- */
  document.querySelectorAll('.pos-cat-btn').forEach(b => b.addEventListener('click', () => { state.posCategory = b.getAttribute('data-cat'); render(); }));
  document.querySelectorAll('.pos-item-card').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const item = state.menuItems.find(i => i.id === id);
    if (item && item.variants && item.variants.length > 0) { state.pickingVariantFor = id; render(); }
    else addToCart(id);
  }));
  document.getElementById('closeVariantPickerBtn')?.addEventListener('click', () => { state.pickingVariantFor = null; render(); });
  document.querySelectorAll('.variant-pick-btn').forEach(b => b.addEventListener('click', () => {
    addToCart(state.pickingVariantFor, b.getAttribute('data-variant'));
    state.pickingVariantFor = null;
    render();
  }));
  document.querySelectorAll('.cart-qty-btn').forEach(b => b.addEventListener('click', () => changeCartQty(b.getAttribute('data-id'), b.getAttribute('data-variant') || null, Number(b.getAttribute('data-delta')))));
  document.getElementById('clearCartBtn')?.addEventListener('click', clearCart);
  document.getElementById('pos-customer-name')?.addEventListener('input', e => { state.posCustomerName = e.target.value; });
  document.querySelectorAll('.pos-ordertype-btn').forEach(b => b.addEventListener('click', () => { state.posOrderType = b.getAttribute('data-type'); render(); }));
  document.querySelectorAll('.pos-discount-btn').forEach(b => b.addEventListener('click', () => { state.posDiscount = b.getAttribute('data-discount'); render(); }));
  document.querySelectorAll('.pos-payment-btn').forEach(b => b.addEventListener('click', () => { state.posPayment = b.getAttribute('data-method'); render(); }));
  document.getElementById('checkoutBtn')?.addEventListener('click', checkoutAction);
  document.getElementById('syncOfflineBtn')?.addEventListener('click', syncOfflineQueue);

  /* ---- POS: Cashier shifts ---- */
  document.getElementById('openStartShiftBtn')?.addEventListener('click', () => { state.showStartShiftPanel = true; state.startingCashInput = ''; render(); });
  document.getElementById('cancelStartShiftBtn')?.addEventListener('click', () => { state.showStartShiftPanel = false; render(); });
  document.getElementById('startingCashField')?.addEventListener('input', e => { state.startingCashInput = e.target.value; });
  document.getElementById('confirmStartShiftBtn')?.addEventListener('click', () => {
    const amt = document.getElementById('startingCashField').value;
    const num = amt === '' ? 0 : Number(amt);
    if (isNaN(num) || num < 0) { toast('Enter a valid amount.', 'bad'); return; }
    startShiftAction(num);
  });
  document.getElementById('openTurnoverBtn')?.addEventListener('click', () => { state.showTurnoverPanel = true; state.turnoverCountedCash = ''; state.turnoverNotes = ''; render(); });
  document.getElementById('cancelTurnoverBtn')?.addEventListener('click', () => { state.showTurnoverPanel = false; render(); });
  document.getElementById('turnoverCashField')?.addEventListener('input', e => { state.turnoverCountedCash = e.target.value; });
  document.getElementById('turnoverNotesField')?.addEventListener('input', e => { state.turnoverNotes = e.target.value; });
  document.getElementById('confirmTurnoverBtn')?.addEventListener('click', () => {
    const amt = document.getElementById('turnoverCashField').value;
    if (amt === '' || isNaN(Number(amt)) || Number(amt) < 0) { toast('Enter the counted cash amount.', 'bad'); return; }
    turnoverAction(Number(amt), document.getElementById('turnoverNotesField').value);
  });
  document.getElementById('closeTurnoverResultBtn')?.addEventListener('click', () => { state.turnoverResult = null; render(); });

  /* ---- POS: Recipes ---- */
  document.querySelectorAll('.view-recipe-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.recipeViewingId = state.recipeViewingId === id ? null : id;
    state.editingRecipeId = null;
    render();
  }));
  document.querySelectorAll('.edit-recipe-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const item = state.menuItems.find(x => x.id === id);
    state.editingRecipeId = id;
    state.recipeDraft = item.recipe || '';
    state.recipeViewingId = null;
    render();
    document.getElementById('recipe-draft-' + id)?.focus();
  }));
  document.getElementById('recipe-draft-' + state.editingRecipeId)?.addEventListener('input', e => { state.recipeDraft = e.target.value; });
  document.querySelectorAll('.cancel-recipe-btn').forEach(b => b.addEventListener('click', () => { state.editingRecipeId = null; render(); }));
  document.querySelectorAll('.save-recipe-btn').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-id');
    const text = document.getElementById('recipe-draft-' + id).value;
    try {
      await api('/api/menu/' + id, { method: 'PUT', body: JSON.stringify({ recipe: text }) });
      const item = state.menuItems.find(x => x.id === id);
      if (item) item.recipe = text;
      state.editingRecipeId = null;
      state.recipeViewingId = id;
      toast('Recipe saved.', 'good');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }));
  document.querySelectorAll('.upload-recipe-image-btn').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-id');
    const fileInput = document.getElementById('recipe-image-file-' + id);
    if (!fileInput.files[0]) { toast('Choose a photo first.', 'bad'); return; }
    const fd = new FormData();
    fd.append('image', fileInput.files[0]);
    try {
      const updated = await api('/api/menu/' + id + '/recipe-image', { method: 'POST', body: fd });
      const item = state.menuItems.find(x => x.id === id);
      if (item) item.recipe_image = updated.recipe_image;
      toast('Photo uploaded.', 'good');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }));
  document.querySelectorAll('.remove-recipe-image-btn').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-id');
    try {
      await api('/api/menu/' + id + '/recipe-image', { method: 'DELETE' });
      const item = state.menuItems.find(x => x.id === id);
      if (item) item.recipe_image = null;
      toast('Photo removed.', 'accent');
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }));

  /* ---- POS: Kitchen queue ---- */
  document.getElementById('kitchenToggleServed')?.addEventListener('click', async () => {
    state.kitchenIncludeServed = !state.kitchenIncludeServed;
    state.loadingTab = true; render();
    await loadKitchenQueue();
    state.loadingTab = false; render();
  });
  document.getElementById('kitchenRefreshBtn')?.addEventListener('click', async () => {
    await loadKitchenQueue();
    render();
  });
  document.querySelectorAll('.kitchen-serve-btn').forEach(b => b.addEventListener('click', () => markServedAction(b.getAttribute('data-id'))));
  document.querySelectorAll('.kitchen-unserve-btn').forEach(b => b.addEventListener('click', () => unserveAction(b.getAttribute('data-id'))));

  /* ---- POS: Sales history ---- */
  document.getElementById('salesDatePick')?.addEventListener('change', async e => {
    state.salesDate = e.target.value;
    state.loadingTab = true; render();
    await loadSalesHistory();
    state.loadingTab = false; render();
  });
  document.querySelectorAll('.approvals-filter-btn').forEach(b => b.addEventListener('click', async () => {
    state.approvalsFilter = b.getAttribute('data-status');
    state.loadingTab = true; render();
    await loadApprovals();
    state.loadingTab = false; render();
  }));
  document.querySelectorAll('.approval-review-btn').forEach(b => b.addEventListener('click', () => reviewApprovalAction(b.getAttribute('data-id'), b.getAttribute('data-status'))));
  document.getElementById('shiftsStartPick')?.addEventListener('change', async e => {
    state.shiftsStart = e.target.value;
    state.loadingTab = true; render();
    await loadShiftsHistory();
    state.loadingTab = false; render();
  });
  document.getElementById('shiftsEndPick')?.addEventListener('change', async e => {
    state.shiftsEnd = e.target.value;
    state.loadingTab = true; render();
    await loadShiftsHistory();
    state.loadingTab = false; render();
  });
  document.querySelectorAll('.void-sale-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.reasonInput = '';
    state.confirmModal = {
      title: 'Void this sale?', body: "This marks the transaction as voided and removes it from totals. The original record is kept, not deleted. This can't be undone.",
      confirmLabel: 'Void sale', danger: true, requireReason: true, reasonPlaceholder: 'e.g. Wrong order entered',
      onConfirm: () => voidSaleAction(id, state.reasonInput.trim())
    };
    render();
  }));
  document.querySelectorAll('.refund-sale-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const remaining = Number(b.getAttribute('data-remaining'));
    state.reasonInput = '';
    state.amountInput = remaining.toFixed(2);
    state.confirmModal = {
      title: 'Refund this sale?', body: `Up to ${fmtMoney(remaining)} can be refunded. This creates a separate credit memo — the original sale record stays unchanged.`,
      confirmLabel: 'Issue refund', danger: true, requireReason: true, reasonPlaceholder: 'e.g. Item was wrong / customer request',
      amountInput: true, maxAmount: remaining,
      onConfirm: () => {
        const amt = Number(document.getElementById('modalAmountInput').value);
        if (!amt || amt <= 0 || amt > remaining) { toast('Enter a valid refund amount.', 'bad'); return; }
        refundSaleAction(id, amt, state.reasonInput.trim());
      }
    };
    render();
  }));

  /* ---- POS: Menu items (admin) ---- */
  document.getElementById('newMenuItemBtn')?.addEventListener('click', () => {
    state.editMenuItem = { id: null, name: '', category: '', price: '', barcode: '', _existing: false, variants_draft: [] };
    render();
  });
  document.querySelectorAll('.edit-menu-item-btn').forEach(b => b.addEventListener('click', () => {
    const item = state.menuItems.find(x => x.id === b.getAttribute('data-id'));
    state.editMenuItem = Object.assign({}, item, { _existing: true, variants_draft: (item.variants || []).map(v => Object.assign({}, v)) });
    render();
  }));
  document.querySelectorAll('.del-menu-item-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    const item = state.menuItems.find(x => x.id === id);
    state.confirmModal = {
      title: 'Delete menu item?', body: `This removes <b>${escapeHtml(item.name)}</b> from the menu. Past sales stay in the log.`,
      confirmLabel: 'Delete', danger: true, onConfirm: () => deleteMenuItemAction(id)
    };
    render();
  }));
  document.getElementById('mf-cancel')?.addEventListener('click', () => { state.editMenuItem = null; render(); });
  document.getElementById('mf-add-variant')?.addEventListener('click', () => {
    if (!state.editMenuItem.variants_draft) state.editMenuItem.variants_draft = [];
    state.editMenuItem.variants_draft.push({ name: '', price: '' });
    render();
  });
  document.querySelectorAll('.mf-variant-remove').forEach(b => b.addEventListener('click', () => {
    state.editMenuItem.variants_draft.splice(Number(b.getAttribute('data-idx')), 1);
    render();
  }));
  document.querySelectorAll('.mf-variant-name').forEach(inp => inp.addEventListener('input', e => {
    state.editMenuItem.variants_draft[Number(e.target.getAttribute('data-idx'))].name = e.target.value;
  }));
  document.querySelectorAll('.mf-variant-price').forEach(inp => inp.addEventListener('input', e => {
    state.editMenuItem.variants_draft[Number(e.target.getAttribute('data-idx'))].price = e.target.value;
  }));
  document.getElementById('mf-save')?.addEventListener('click', () => {
    const name = document.getElementById('mf-name').value.trim();
    if (!name) { toast('Item needs a name.', 'bad'); return; }
    const price = document.getElementById('mf-price').value;
    if (price === '' || isNaN(Number(price)) || Number(price) < 0) { toast('Enter a valid price.', 'bad'); return; }
    const variants = (state.editMenuItem.variants_draft || [])
      .filter(v => v.name && v.name.trim())
      .map(v => ({ name: v.name.trim(), price: Number(v.price) }));
    if (variants.some(v => isNaN(v.price) || v.price < 0)) { toast('Every size needs a valid price.', 'bad'); return; }
    const payload = {
      name,
      category: document.getElementById('mf-category').value.trim(),
      price: Number(price),
      barcode: document.getElementById('mf-barcode').value.trim(),
      recipe: document.getElementById('mf-recipe').value.trim(),
      variants
    };
    saveMenuItemAction(payload, state.editMenuItem._existing ? state.editMenuItem.id : null);
  });

  /* ---- Time Clock ---- */
  document.getElementById('clockToggleBtn')?.addEventListener('click', () => {
    if (state.clockStatus && state.clockStatus.clockedIn) clockOutAction();
    else clockInAction();
  });

  /* ---- Time: Team log (admin) ---- */
  document.getElementById('teamDatePick')?.addEventListener('change', async e => {
    state.teamTimeDate = e.target.value;
    state.loadingTab = true; render();
    state.teamTimeEntries = await api('/api/time/entries?date=' + state.teamTimeDate);
    state.loadingTab = false; render();
  });
  document.querySelectorAll('.edit-time-entry-btn').forEach(b => b.addEventListener('click', () => {
    const entry = state.teamTimeEntries.find(x => x.id === b.getAttribute('data-id'));
    state.editTimeEntry = Object.assign({}, entry);
    render();
  }));
  document.querySelectorAll('.del-time-entry-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.confirmModal = {
      title: 'Delete this punch?', body: "This permanently removes the clock-in/out record.",
      confirmLabel: 'Delete', danger: true, onConfirm: () => deleteTimeEntryAction(id)
    };
    render();
  }));
  document.getElementById('tf-cancel')?.addEventListener('click', () => { state.editTimeEntry = null; render(); });
  document.getElementById('tf-save')?.addEventListener('click', () => {
    const inVal = document.getElementById('tf-in').value;
    const outVal = document.getElementById('tf-out').value;
    if (!inVal) { toast('Clock-in time is required.', 'bad'); return; }
    saveTimeEntryAction(state.editTimeEntry.id, {
      clockIn: localInputToUtc(inVal),
      clockOut: outVal ? localInputToUtc(outVal) : null
    });
  });

  /* ---- Time: Payroll (admin) ---- */
  document.getElementById('payrollStartPick')?.addEventListener('change', async e => {
    state.payrollStart = e.target.value;
    state.loadingTab = true; render();
    await loadPayroll();
    state.loadingTab = false; render();
  });
  document.getElementById('payrollEndPick')?.addEventListener('change', async e => {
    state.payrollEnd = e.target.value;
    state.loadingTab = true; render();
    await loadPayroll();
    state.loadingTab = false; render();
  });

  /* ---- Schedule ---- */
  document.getElementById('scheduleDatePick')?.addEventListener('change', async e => {
    state.scheduleDate = e.target.value;
    state.loadingTab = true; render();
    await loadSchedule();
    state.loadingTab = false; render();
  });
  document.getElementById('newShiftBtn')?.addEventListener('click', () => {
    state.editShift = { id: null, userId: state.users.find(u => u.active)?.id || null, startTime: '09:00', endTime: '17:00', notes: '', _existing: false };
    render();
  });
  document.querySelectorAll('.edit-shift-btn').forEach(b => b.addEventListener('click', () => {
    const sh = state.scheduleShifts.find(x => x.id === b.getAttribute('data-id'));
    state.editShift = { id: sh.id, userId: sh.user_id, startTime: sh.start_time, endTime: sh.end_time, notes: sh.notes, _existing: true };
    render();
  }));
  document.querySelectorAll('.del-shift-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.confirmModal = {
      title: 'Delete this shift?', body: "This removes the shift from the schedule.",
      confirmLabel: 'Delete', danger: true, onConfirm: () => deleteShiftAction(id)
    };
    render();
  }));
  document.getElementById('sf-cancel')?.addEventListener('click', () => { state.editShift = null; render(); });
  document.getElementById('sf-save')?.addEventListener('click', () => {
    const userId = Number(document.getElementById('sf-user').value);
    const startTime = document.getElementById('sf-start').value;
    const endTime = document.getElementById('sf-end').value;
    if (!startTime || !endTime) { toast('Set both a start and end time.', 'bad'); return; }
    if (endTime <= startTime) { toast('End time must be after start time.', 'bad'); return; }
    const payload = { userId, date: state.scheduleDate, startTime, endTime, notes: document.getElementById('sf-notes').value.trim() };
    saveShiftAction(payload, state.editShift._existing ? state.editShift.id : null);
  });

  /* ---- POS: receipt printing ---- */
  document.getElementById('printReceiptBtn')?.addEventListener('click', () => { if (state.lastSale) printReceipt(state.lastSale); });
  document.getElementById('printBluetoothBtn')?.addEventListener('click', () => { if (state.lastSale) printViaBluetooth(state.lastSale); });

  /* ---- POS: Bluetooth devices ---- */
  document.getElementById('devicesBtn')?.addEventListener('click', () => { state.showDevicesPanel = !state.showDevicesPanel; render(); });
  document.getElementById('closeDevicesBtn')?.addEventListener('click', () => { state.showDevicesPanel = false; render(); });
  document.getElementById('connectPrinterBtn')?.addEventListener('click', connectBluetoothPrinter);
  document.getElementById('disconnectPrinterBtn')?.addEventListener('click', disconnectBluetoothPrinter);
  document.getElementById('connectScannerBtn')?.addEventListener('click', connectBluetoothScanner);
  document.getElementById('disconnectScannerBtn')?.addEventListener('click', disconnectBluetoothScanner);

  /* ---- HR: Notices & Policies ---- */
  document.querySelectorAll('.hr-sec-btn').forEach(b => b.addEventListener('click', () => { state.hrSection = b.getAttribute('data-sec'); state.newNotice = null; state.editPolicy = null; render(); }));

  /* ---- Staff Requests: Availability / Leave / Feedback / Exceptions ---- */
  document.querySelectorAll('.req-sec-btn').forEach(b => b.addEventListener('click', async () => {
    state.requestsSection = b.getAttribute('data-sec');
    state.loadingTab = true; render();
    await loadRequestsData();
    state.loadingTab = false; render();
  }));
  document.getElementById('availWeekPick')?.addEventListener('change', async e => {
    state.availabilityWeek = e.target.value;
    state.loadingTab = true; render();
    await loadRequestsData();
    state.loadingTab = false; render();
  });
  document.querySelectorAll('.avail-day-btn').forEach(b => b.addEventListener('click', () => {
    const day = b.getAttribute('data-day');
    const val = b.getAttribute('data-val') === 'true';
    state.availDaysDraft[day] = Object.assign({}, state.availDaysDraft[day], { available: val });
    render();
  }));
  document.getElementById('availNotesField')?.addEventListener('input', e => { state.availNotesDraft = e.target.value; });
  document.getElementById('submitAvailBtn')?.addEventListener('click', submitAvailabilityAction);

  document.getElementById('leaveStartField')?.addEventListener('input', e => { state.leaveForm.startDate = e.target.value; });
  document.getElementById('leaveEndField')?.addEventListener('input', e => { state.leaveForm.endDate = e.target.value; });
  document.getElementById('leaveReasonField')?.addEventListener('input', e => { state.leaveForm.reason = e.target.value; });
  document.getElementById('leaveNotesField')?.addEventListener('input', e => { state.leaveForm.notes = e.target.value; });
  document.getElementById('submitLeaveBtn')?.addEventListener('click', submitLeaveAction);
  document.querySelectorAll('.leave-filter-btn').forEach(b => b.addEventListener('click', async () => {
    state.leaveFilter = b.getAttribute('data-status');
    state.loadingTab = true; render();
    await loadRequestsData();
    state.loadingTab = false; render();
  }));
  document.querySelectorAll('.leave-review-btn').forEach(b => b.addEventListener('click', () => reviewLeaveAction(b.getAttribute('data-id'), b.getAttribute('data-status'))));

  document.querySelectorAll('.feedback-cat-btn').forEach(b => b.addEventListener('click', () => { state.feedbackCategory = b.getAttribute('data-cat'); render(); }));
  document.getElementById('feedbackMessageField')?.addEventListener('input', e => { state.feedbackMessage = e.target.value; });
  document.getElementById('submitFeedbackBtn')?.addEventListener('click', submitFeedbackAction);

  document.querySelectorAll('.exception-filter-btn').forEach(b => b.addEventListener('click', async () => {
    state.exceptionFilter = b.getAttribute('data-status');
    state.loadingTab = true; render();
    await loadRequestsData();
    state.loadingTab = false; render();
  }));
  document.querySelectorAll('.exception-review-btn').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-id');
    const status = b.getAttribute('data-status');
    try {
      await api('/api/time/schedule-exceptions/' + id + '/review', { method: 'PUT', body: JSON.stringify({ status }) });
      toast(status === 'approved' ? 'Approved.' : 'Denied.', status === 'approved' ? 'good' : 'accent');
      await loadRequestsData();
      render();
    } catch (e) { toast(e.message, 'bad'); }
  }));

  /* ---- Shift turnover verification ---- */
  document.querySelectorAll('.verify-shift-btn').forEach(b => b.addEventListener('click', () => {
    const shift = state.shiftsHistory.find(s => s.id === b.getAttribute('data-id'));
    if (shift) openVerifyModal(shift);
  }));
  document.getElementById('closeVerifyModalBtn')?.addEventListener('click', closeVerifyModal);
  document.getElementById('verifyAmountField')?.addEventListener('input', e => { state.verifyAmountInput = e.target.value; });
  document.getElementById('verifyEmailField')?.addEventListener('input', e => { state.verifyEmailInput = e.target.value; });
  document.querySelectorAll('.verify-digit').forEach(b => b.addEventListener('click', () => verifyPressDigit(b.getAttribute('data-d'))));
  document.getElementById('verifyPinBack')?.addEventListener('click', verifyBackspace);
  document.getElementById('verifyPinEnter')?.addEventListener('click', submitShiftVerification);

  /* ---- Discount approval modal ---- */
  document.getElementById('closeDiscountApprovalBtn')?.addEventListener('click', closeDiscountApprovalModal);
  document.getElementById('discountApprovalEmailField')?.addEventListener('input', e => { state.discountApprovalEmailInput = e.target.value; });
  document.querySelectorAll('.discount-approval-digit').forEach(b => b.addEventListener('click', () => discountApprovalPressDigit(b.getAttribute('data-d'))));
  document.getElementById('discountApprovalBack')?.addEventListener('click', discountApprovalBackspace);
  document.getElementById('discountApprovalEnter')?.addEventListener('click', submitDiscountApproval);

  document.getElementById('newNoticeBtn')?.addEventListener('click', () => {
    state.newNotice = { type: 'memo', userId: null, title: '', body: '', requiresAck: true };
    render();
  });
  document.querySelectorAll('.notice-type-btn').forEach(b => b.addEventListener('click', () => { state.newNotice.type = b.getAttribute('data-type'); render(); }));
  document.getElementById('nf-cancel')?.addEventListener('click', () => { state.newNotice = null; render(); });
  document.getElementById('nf-recipient')?.addEventListener('change', e => {
    state.newNotice.userId = e.target.value ? Number(e.target.value) : null;
    render();
  });
  document.getElementById('nf-send')?.addEventListener('click', () => {
    const title = document.getElementById('nf-title').value.trim();
    const body = document.getElementById('nf-body').value.trim();
    if (!title || !body) { toast('Title and message are required.', 'bad'); return; }
    const recipientVal = document.getElementById('nf-recipient').value;
    const fileInput = document.getElementById('nf-attachment');

    const fd = new FormData();
    fd.append('type', state.newNotice.type);
    fd.append('title', title);
    fd.append('body', body);
    if (recipientVal) fd.append('userId', recipientVal);
    fd.append('requiresAck', document.getElementById('nf-requiresack').checked ? 'true' : 'false');
    fd.append('sendEmail', document.getElementById('nf-sendemail').checked ? 'true' : 'false');
    if (fileInput.files[0]) fd.append('attachment', fileInput.files[0]);

    sendNoticeAction(fd);
  });
  document.querySelectorAll('.del-notice-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.confirmModal = {
      title: 'Delete this notice?', body: "This removes it for everyone it was sent to.",
      confirmLabel: 'Delete', danger: true, onConfirm: () => deleteNoticeAction(id)
    };
    render();
  }));
  document.querySelectorAll('.ack-notice-btn').forEach(b => b.addEventListener('click', () => acknowledgeNoticeAction(b.getAttribute('data-id'))));
  document.querySelectorAll('.download-attachment-btn').forEach(b => b.addEventListener('click', async () => {
    const id = b.getAttribute('data-id');
    const filename = b.getAttribute('data-name');
    try {
      const res = await fetch('/api/notices/' + id + '/attachment', { headers: { Authorization: 'Bearer ' + TOKEN } });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) { toast('Could not download attachment.', 'bad'); }
  }));

  document.getElementById('newPolicyBtn')?.addEventListener('click', () => {
    state.editPolicy = { id: null, title: '', category: '', body: '', _existing: false };
    render();
  });
  document.querySelectorAll('.edit-policy-btn').forEach(b => b.addEventListener('click', () => {
    const p = state.policies.find(x => x.id === b.getAttribute('data-id'));
    state.editPolicy = Object.assign({}, p, { _existing: true });
    render();
  }));
  document.querySelectorAll('.del-policy-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.confirmModal = {
      title: 'Delete this policy?', body: "Staff will no longer be able to view it.",
      confirmLabel: 'Delete', danger: true, onConfirm: () => deletePolicyAction(id)
    };
    render();
  }));
  document.getElementById('pf2-cancel')?.addEventListener('click', () => { state.editPolicy = null; render(); });
  document.getElementById('pf2-save')?.addEventListener('click', () => {
    const title = document.getElementById('pf2-title').value.trim();
    const body = document.getElementById('pf2-body').value.trim();
    if (!title || !body) { toast('Title and content are required.', 'bad'); return; }
    const payload = { title, category: document.getElementById('pf2-category').value.trim(), body };
    savePolicyAction(payload, state.editPolicy._existing ? state.editPolicy.id : null);
  });

  /* ---- Barcode scanning (Add/Discard Stock) ---- */
  document.querySelectorAll('.barcode-scan-input').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); scanBarcodeAction(inp.value); }
    });
  });

  /* ---- Breaks / lunch ---- */
  document.querySelectorAll('.break-start-btn').forEach(b => b.addEventListener('click', () => startBreakAction(b.getAttribute('data-type'))));
  document.getElementById('endBreakBtn')?.addEventListener('click', endBreakAction);

  /* ---- Attendance marking (admin) ---- */
  document.getElementById('markAttendanceBtn')?.addEventListener('click', () => {
    state.markAttendance = { userId: state.users.find(u => u.active)?.id || null, date: state.teamTimeDate, status: 'absent', notes: '' };
    render();
  });
  document.getElementById('am-user')?.addEventListener('change', e => { state.markAttendance.userId = Number(e.target.value); });
  document.querySelectorAll('.am-status-btn').forEach(b => b.addEventListener('click', () => { state.markAttendance.status = b.getAttribute('data-status'); render(); }));
  document.getElementById('am-notes')?.addEventListener('input', e => { state.markAttendance.notes = e.target.value; });
  document.getElementById('am-cancel')?.addEventListener('click', () => { state.markAttendance = null; render(); });
  document.getElementById('am-save')?.addEventListener('click', () => {
    const m = state.markAttendance;
    if (!m.userId) { toast('Select a staff member.', 'bad'); return; }
    saveAttendanceMarkAction({ userId: m.userId, date: state.teamTimeDate, status: m.status, notes: m.notes });
  });
  document.querySelectorAll('.del-attendance-mark-btn').forEach(b => b.addEventListener('click', () => {
    const id = b.getAttribute('data-id');
    state.confirmModal = {
      title: 'Remove attendance mark?', body: "This clears the absent/AWOL/undertime record for that day.",
      confirmLabel: 'Remove', danger: true, onConfirm: () => deleteAttendanceMarkAction(id)
    };
    render();
  }));

  /* ---- Time: Evaluate (admin) ---- */
  document.querySelectorAll('.eval-mode-btn').forEach(b => b.addEventListener('click', async () => {
    state.evalMode = b.getAttribute('data-mode');
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  }));
  document.getElementById('evalDatePick')?.addEventListener('change', async e => {
    state.evalDate = e.target.value;
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  });
  document.getElementById('evalMonthPick')?.addEventListener('change', async e => {
    state.evalMonth = e.target.value;
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  });
  document.getElementById('evalYearPick')?.addEventListener('change', async e => {
    state.evalYear = e.target.value;
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  });
  document.getElementById('evalWeekPick')?.addEventListener('change', async e => {
    state.evalWeek = e.target.value;
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  });
  document.getElementById('evalCustomStartPick')?.addEventListener('change', async e => {
    state.evalCustomStart = e.target.value;
    if (state.evalCustomEnd < state.evalCustomStart) state.evalCustomEnd = state.evalCustomStart;
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  });
  document.getElementById('evalCustomEndPick')?.addEventListener('change', async e => {
    if (e.target.value < state.evalCustomStart) { toast('End date must be on or after the start date.', 'bad'); render(); return; }
    state.evalCustomEnd = e.target.value;
    state.loadingTab = true; render();
    await loadEvalData();
    state.loadingTab = false; render();
  });
}

/* ============================= BOOT ============================= */
function applyTheme(theme) {
  const valid = ['dark', 'light', 'dark-green', 'khaki', 'dark-pink', 'dark-blue'];
  if (theme && theme !== 'dark' && valid.includes(theme)) {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme'); // 'dark' is the unattributed :root default
  }
}

window.addEventListener('online', () => {
  state.isOnline = true;
  render();
  syncOfflineQueue();
});
window.addEventListener('offline', () => {
  state.isOnline = false;
  render();
});

(async function boot() {
  loadOfflineQueue();
  render();
  try {
    const pub = await api('/api/admin/public');
    if (pub.cafe_name) state.cafeName = pub.cafe_name;
    applyTheme(pub.theme);
  } catch (e) { /* fall back to defaults if this fails - never block boot on branding */ }

  if (TOKEN) {
    try {
      const data = await api('/api/auth/me');
      state.user = data.user;
      await loadCore();
      state.booted = true;
      render();
      await switchTab('dashboard');
      return;
    } catch (e) {
      if (looksLikeNetworkFailure(e)) {
        // Genuinely offline at boot, not an invalid session — keep the token so
        // a reload once back online logs them straight back in.
        state.booted = true;
        render();
        return;
      }
      TOKEN = null;
      localStorage.removeItem('sl_token');
    }
  }
  state.booted = true;
  render();
})();
