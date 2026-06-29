// РНП v3 — Рука на пульсе · Wildberries
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 4810;
const DB = path.join(__dirname, 'data', 'db.json');
const PUB = path.join(__dirname, 'public');

const DEFAULT_DB = {
  settings: { apiKey: '', taxRate: 7, usdRate: 90, ffStock: {} },
  products: [],   // {id, sku, wbId, name, cost, pkg, commission, logistics, buyout, price, manager, status, planDrr}
  plans: {},      // {"YYYY-MM": {sku: {ordRub, ordQty}}}
  days: [],       // {id, date, sku, ordQ, ordS, buyQ, buyS, stock, shows, clicks, cart, adsShows, adsClicks, adsSpend, spp, giveaway, source}
  campaigns: [],  // {id, sku, campId, dateFrom, dateTo, spend, shows, clicks, orders, buyQ, type, note}
  log: []
};

function loadDB() {
  try { return Object.assign({}, DEFAULT_DB, JSON.parse(fs.readFileSync(DB, 'utf8'))); }
  catch { return JSON.parse(JSON.stringify(DEFAULT_DB)); }
}
function saveDB(db) { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); }
function addLog(db, msg) {
  db.log.unshift({ t: new Date().toISOString(), msg });
  db.log = db.log.slice(0, 200);
}

function send(res, code, data, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  if (Buffer.isBuffer(data) || typeof data === 'string') res.end(data);
  else res.end(JSON.stringify(data));
}
function body(req) {
  return new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });
}

// ---- WB Statistics API ----
const WB_BASE = 'https://statistics-api.wildberries.ru';
async function wbGet(key, urlPath) {
  const res = await fetch(WB_BASE + urlPath, { headers: { Authorization: key } });
  if (!res.ok) throw new Error('WB ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function wbSync(db, key, dateFrom) {
  const out = { orders: 0, sales: 0, stocks: 0, days: 0 };
  const orders = await wbGet(key, `/api/v1/supplier/orders?dateFrom=${dateFrom}&flag=0`);
  out.orders = orders.length;
  const sales = await wbGet(key, `/api/v1/supplier/sales?dateFrom=${dateFrom}&flag=0`);
  out.sales = sales.length;
  const stocks = await wbGet(key, `/api/v1/supplier/stocks?dateFrom=${dateFrom}`);
  out.stocks = stocks.length;

  const map = {};
  const skuOf = o => o.supplierArticle || String(o.nmId || 'WB');
  const dateOf = d => (d || '').slice(0, 10);
  function bucket(date, sku) {
    const k = date + '|' + sku;
    if (!map[k]) map[k] = { date, sku, ordQ: 0, ordS: 0, buyQ: 0, buyS: 0, stock: 0, shows: 0, clicks: 0, cart: 0, adsShows: 0, adsClicks: 0, adsSpend: 0, spp: 0, giveaway: 0 };
    return map[k];
  }
  orders.forEach(o => { const b = bucket(dateOf(o.date), skuOf(o)); b.ordQ += 1; b.ordS += (o.priceWithDisc || o.totalPrice || 0); });
  sales.forEach(s => { if ((s.saleID || '').startsWith('S')) { const b = bucket(dateOf(s.date), skuOf(s)); b.buyQ += 1; b.buyS += (s.priceWithDisc || s.forPay || 0); } });

  const stockBySku = {};
  stocks.forEach(s => { const sk = skuOf(s); stockBySku[sk] = (stockBySku[sk] || 0) + (s.quantity || 0); });
  const today = new Date().toISOString().slice(0, 10);
  Object.entries(stockBySku).forEach(([sku, q]) => { bucket(today, sku).stock = q; });

  const known = new Set(db.products.map(p => p.sku));
  Object.keys(stockBySku).concat(orders.map(skuOf)).forEach(sku => {
    if (!known.has(sku)) {
      known.add(sku);
      db.products.push({ id: 'p' + Date.now() + Math.random().toString(36).slice(2, 6), sku, wbId: '', name: sku, cost: 0, pkg: 0, commission: 15, logistics: 0, buyout: 70, price: 0, manager: '', status: 'НЕ ВЫБРАНО', planDrr: 0 });
    }
  });

  db.days = db.days.filter(d => d.source !== 'wb' || d.date < dateFrom);
  Object.values(map).forEach(b => {
    db.days.push({ id: 'wb' + b.date + b.sku, ...b, source: 'wb' });
  });
  out.days = Object.keys(map).length;
  addLog(db, `Синк WB: заказы ${out.orders}, выкупы ${out.sales}, остатки ${out.stocks}, дней·SKU ${out.days}`);
  return out;
}

const ARC_DIR = path.join(__dirname, 'data', 'archive');
if (!fs.existsSync(ARC_DIR)) fs.mkdirSync(ARC_DIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (p.startsWith('/api/')) {
    const db = loadDB();
    try {
      if (p === '/api/state' && req.method === 'GET') return send(res, 200, db);
      if (p === '/api/save' && req.method === 'POST') {
        const b = await body(req);
        ['settings', 'products', 'plans', 'days', 'campaigns'].forEach(k => { if (b[k] !== undefined) db[k] = b[k]; });
        saveDB(db); return send(res, 200, { ok: true });
      }
      if (p === '/api/wb/test' && req.method === 'POST') {
        const b = await body(req);
        const key = b.apiKey || db.settings.apiKey;
        try {
          const today = new Date().toISOString().slice(0, 10);
          const o = await wbGet(key, `/api/v1/supplier/orders?dateFrom=${today}&flag=1`);
          return send(res, 200, { ok: true, msg: `Подключение успешно. Заказов за сегодня: ${o.length}` });
        } catch (e) { return send(res, 200, { ok: false, msg: 'Ошибка: ' + e.message }); }
      }
      if (p === '/api/wb/sync' && req.method === 'POST') {
        const b = await body(req);
        const key = b.apiKey || db.settings.apiKey;
        if (!key) return send(res, 200, { ok: false, msg: 'Нет API-ключа' });
        if (b.apiKey) db.settings.apiKey = b.apiKey;
        const dateFrom = b.dateFrom || new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
        try {
          const r = await wbSync(db, key, dateFrom);
          saveDB(db);
          return send(res, 200, { ok: true, msg: `Готово. Заказы ${r.orders}, выкупы ${r.sales}, остатки ${r.stocks}`, result: r });
        } catch (e) { addLog(db, 'Ошибка синка: ' + e.message); saveDB(db); return send(res, 200, { ok: false, msg: e.message }); }
      }
      if (p === '/api/archive/save' && req.method === 'POST') {
        const b = await body(req);
        if (!b.ym) return send(res, 200, { ok: false, msg: 'Нет ym' });
        const file = path.join(ARC_DIR, b.ym + '.json');
        fs.writeFileSync(file, JSON.stringify(b, null, 2));
        return send(res, 200, { ok: true, file });
      }
      if (p === '/api/archive/list' && req.method === 'GET') {
        const files = fs.readdirSync(ARC_DIR).filter(f => f.endsWith('.json')).sort().reverse();
        const list = files.map(f => {
          try { const d = JSON.parse(fs.readFileSync(path.join(ARC_DIR, f), 'utf8')); return { ym: d.ym, name: d.name, savedAt: d.savedAt, days: d.days?.length }; }
          catch { return { ym: f.replace('.json','') }; }
        });
        return send(res, 200, list);
      }
      if (p.startsWith('/api/archive/view') && req.method === 'GET') {
        const ym = u.searchParams.get('ym');
        const file = path.join(ARC_DIR, (ym||'') + '.json');
        if (!ym || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
        return send(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 500, { error: e.message }); }
  }

  let file = p === '/' ? '/index.html' : p;
  const fp = path.join(PUB, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache', 'Expires': '0'
    });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`РНП запущена → http://localhost:${PORT}`));
