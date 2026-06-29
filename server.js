// РНП v3 — Рука на пульсе · Wildberries
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4810;
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
function saveDB(db) {
  try { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); } catch {}
}

// ---- Demo seed (Railway / first launch) ----
function seedDemo(db) {
  if (db.products.length) return;

  // 6 товаров — разные ниши, статусы, экономика
  const prods = [
    { id:'d1', sku:'Платье_цветочное', wbId:'1122334', name:'Платье цветочное миди', cost:890,  pkg:55,  commission:15, logistics:125, buyout:74, price:2790, manager:'Аня',   status:'Локомотив', planDrr:14 },
    { id:'d2', sku:'Ветровка_черная',  wbId:'2233445', name:'Ветровка чёрная оверсайз', cost:1350, pkg:80,  commission:15, logistics:160, buyout:66, price:3590, manager:'Дима',  status:'Рост',      planDrr:19 },
    { id:'d3', sku:'Джинсы_mom',       wbId:'3344556', name:'Джинсы mom fit светлые',   cost:1050, pkg:65,  commission:15, logistics:140, buyout:77, price:3190, manager:'Аня',   status:'Рост',      planDrr:17 },
    { id:'d4', sku:'Топ_базовый',      wbId:'4455667', name:'Топ базовый рибана',       cost:280,  pkg:30,  commission:15, logistics:90,  buyout:82, price:890,  manager:'Света', status:'Локомотив', planDrr:12 },
    { id:'d5', sku:'Юбка_плиссе',      wbId:'5566778', name:'Юбка плиссе миди',         cost:620,  pkg:45,  commission:15, logistics:110, buyout:58, price:1990, manager:'Света', status:'Аутсайдер', planDrr:22 },
    { id:'d6', sku:'Кардиган_oversize', wbId:'6677889', name:'Кардиган оверсайз вязаный', cost:1100, pkg:70, commission:15, logistics:150, buyout:71, price:2990, manager:'Дима',  status:'Новинка',   planDrr:20 },
  ];

  // Профили поведения по товарам: [showsBase, ctrPct, cartPct, ordPctOfClicks, buyoutPct, adsShareOfShows, adsCtrPct, sppBase, stockBase, adsSpendBase]
  const profiles = {
    'Платье_цветочное': { shows:[18000,28000], ctr:[3.5,5.5], cart:[11,18], ord:[4.5,7],   buyout:[70,78], adsShare:.35, adsCtr:[.8,1.4], spp:[12,22], stock:[180,280], ads:[1800,3500], trend:1.08  },
    'Ветровка_черная':  { shows:[12000,20000], ctr:[2.8,4.5], cart:[8,14],  ord:[3.2,5.5], buyout:[62,70], adsShare:.42, adsCtr:[.6,1.1], spp:[15,25], stock:[90,160],  ads:[2200,4000], trend:1.05  },
    'Джинсы_mom':       { shows:[14000,22000], ctr:[3.0,4.8], cart:[9,15],  ord:[3.8,6],   buyout:[73,81], adsShare:.38, adsCtr:[.7,1.2], spp:[10,20], stock:[120,200], ads:[1600,3000], trend:1.06  },
    'Топ_базовый':      { shows:[22000,38000], ctr:[4.0,6.5], cart:[13,22], ord:[5.5,9],   buyout:[78,86], adsShare:.28, adsCtr:[.9,1.6], spp:[8,18],  stock:[350,600], ads:[900,2000],  trend:1.10  },
    'Юбка_плиссе':      { shows:[8000,14000],  ctr:[1.8,3.2], cart:[5,10],  ord:[2.0,3.5], buyout:[52,65], adsShare:.50, adsCtr:[.4,.9],  spp:[18,28], stock:[40,90],   ads:[1200,2800], trend:0.96  },
    'Кардиган_oversize':{ shows:[9000,16000],  ctr:[2.2,3.8], cart:[7,13],  ord:[2.8,4.5], buyout:[67,75], adsShare:.45, adsCtr:[.5,1.0], spp:[12,20], stock:[70,130],  ads:[1400,3200], trend:1.03  },
  };

  const rng  = (a,b) => Math.random()*(b-a)+a;
  const irng = (a,b) => Math.floor(rng(a,b));
  const ym   = new Date().toISOString().slice(0,7);
  const [y,m]= ym.split('-').map(Number);
  const daysInMonth = new Date(y,m,0).getDate();
  const todayD = new Date().getDate();
  const DOW = [0,1,2,3,4,5,6]; // 0=Sun

  const days = [];
  for (let d = 1; d <= Math.min(todayD, daysInMonth); d++) {
    const date = `${ym}-${String(d).padStart(2,'0')}`;
    const dow  = new Date(y,m-1,d).getDay(); // 0=Вс,6=Сб
    const isWknd = dow === 0 || dow === 6;
    const progress = d / daysInMonth; // 0..1 — рост к концу месяца

    for (const p of prods) {
      const pr = profiles[p.sku];
      if (!pr) continue;

      // Тренд + выходные (-20% в выходные для рабочей одежды, +15% для базовых)
      const trendMult = Math.pow(pr.trend, progress * 30);
      const wkndMult  = isWknd ? (p.sku === 'Топ_базовый' ? 1.15 : 0.80) : 1.0;
      const noise     = 0.88 + Math.random() * 0.24;

      const shows     = Math.round(irng(...pr.shows) * trendMult * wkndMult * noise);
      const clicks    = Math.round(shows * rng(...pr.ctr) / 100);
      const cart      = Math.round(clicks * rng(...pr.cart) / 100);
      const ordQ      = Math.round(clicks * rng(...pr.ord) / 100);
      const buyoutPct = rng(...pr.buyout) / 100;
      const buyQ      = Math.max(0, Math.round(ordQ * buyoutPct * (0.92 + Math.random()*.16)));
      const spp       = Math.round(rng(...pr.spp) * 10) / 10;
      const effectivePrice = p.price * (1 - spp/100);
      const ordS      = Math.round(ordQ * effectivePrice);
      const buyS      = Math.round(buyQ * effectivePrice * 0.97);
      const adsShows  = Math.round(shows * pr.adsShare * (0.9 + Math.random()*.2));
      const adsClicks = Math.round(adsShows * rng(...pr.adsCtr) / 100);
      const adsSpend  = irng(...pr.ads) * (isWknd ? 0.7 : 1.0);
      const stock     = Math.max(5, irng(...pr.stock) - Math.round(d * buyQ * 0.1));
      const giveaway  = d <= 5 && Math.random() > 0.6 ? irng(1,3) : 0;

      days.push({ id:`demo_${p.sku}_${date}`, date, sku:p.sku,
        ordQ, ordS, buyQ, buyS, stock, shows, clicks, cart,
        adsShows, adsClicks, adsSpend, spp, giveaway, source:'demo' });
    }
  }

  const planKey = ym;
  db.products = prods;
  db.days     = days;
  db.plans    = { [planKey]: {
    'Платье_цветочное':  { ordQty:700,  ordRub:1953000, buyQty:518 },
    'Ветровка_черная':   { ordQty:420,  ordRub:1507800, buyQty:277 },
    'Джинсы_mom':        { ordQty:480,  ordRub:1531200, buyQty:370 },
    'Топ_базовый':       { ordQty:1200, ordRub:1068000, buyQty:984 },
    'Юбка_плиссе':       { ordQty:280,  ordRub:557200,  buyQty:162 },
    'Кардиган_oversize': { ordQty:320,  ordRub:956800,  buyQty:227 },
  }};
  db.settings = { apiKey:'', taxRate:7, usdRate:90 };
  addLog(db, '🎉 Демо-кабинет загружен: 6 товаров, полный месяц данных. Замени на свои!');
  saveDB(db);
}
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

// Seed demo data on first launch
const _startDb = loadDB();
seedDemo(_startDb);

server.listen(PORT, '0.0.0.0', () => console.log(`РНП запущена → http://localhost:${PORT}`));
