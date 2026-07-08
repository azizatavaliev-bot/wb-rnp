// РНП v5 — Рука на пульсе · Wildberries + Auth
const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const zlib   = require('zlib');

const PORT    = process.env.PORT || 4810;
const PUB     = path.join(__dirname, 'public');
const DATA    = path.join(__dirname, 'data');
const USERS_F = path.join(DATA, 'users.json');
const ARC_DIR = path.join(DATA, 'archive');

// ---- Ensure dirs ----
[DATA, ARC_DIR, path.join(DATA, 'u')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ---- Auth helpers ----
const sessions = new Map(); // token → {userId, email, name, expires}
setInterval(() => { for (const [k, s] of sessions) if (s.expires < Date.now()) sessions.delete(k); }, 3600000);

// ---- In-memory DB cache (ключевое ускорение) ----
const dbCache = new Map(); // "userId::cabinetId" → db object
function loadUserDB(userId, cabinetId) {
  const cid = cabinetId || 'c1';
  const key = userId + '::' + cid;
  if (dbCache.has(key)) return dbCache.get(key);
  let db;
  try { db = Object.assign({}, DEFAULT_DB, JSON.parse(fs.readFileSync(userDbPath(userId, cid), 'utf8'))); }
  catch { db = JSON.parse(JSON.stringify(DEFAULT_DB)); }
  dbCache.set(key, db);
  return db;
}
function saveUserDB(userId, cabinetId, db) {
  const cid = cabinetId || 'c1';
  dbCache.set(userId + '::' + cid, db);
  try { fs.writeFileSync(userDbPath(userId, cid), JSON.stringify(db)); } catch {}
}

// ---- Кабинеты: несколько магазинов/аккаунтов WB внутри одного логина ----
function cabinetsMetaPath(userId) {
  const dir = path.join(DATA, 'u', String(userId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'cabinets.json');
}
function loadCabinetsMeta(userId) {
  const fp = cabinetsMetaPath(userId);
  try {
    const meta = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (meta && Array.isArray(meta.list) && meta.list.length) return meta;
  } catch {}
  // Миграция: у пользователя уже есть db.json (старый однокабинетный формат) → заворачиваем в кабинет "c1"
  const meta = { activeId: 'c1', list: [{ id: 'c1', name: 'Основной кабинет', createdAt: new Date().toISOString() }] };
  saveCabinetsMeta(userId, meta);
  return meta;
}
function saveCabinetsMeta(userId, meta) {
  fs.writeFileSync(cabinetsMetaPath(userId), JSON.stringify(meta, null, 2));
}
function archiveDirFor(userId, cabinetId) {
  const cid = cabinetId || 'c1';
  return cid === 'c1'
    ? path.join(DATA, 'u', String(userId), 'archive')
    : path.join(DATA, 'u', String(userId), 'cabinets', cid, 'archive');
}

// ---- Rate limiting (защита от брутфорса) ----
const rateLimits = new Map(); // ip → { count, reset }
const RATE_WINDOW = 60000; // 1 минута
const RATE_MAX    = 20;    // макс 20 auth-запросов в минуту
function rateLimit(ip) {
  const now = Date.now();
  let r = rateLimits.get(ip);
  if (!r || r.reset < now) { r = { count:0, reset: now + RATE_WINDOW }; rateLimits.set(ip, r); }
  r.count++;
  return r.count > RATE_MAX;
}
setInterval(() => { const now = Date.now(); for (const [k,v] of rateLimits) if (v.reset < now) rateLimits.delete(k); }, 60000);

// ---- Security headers ----
const IS_PROD = !!process.env.RAILWAY_ENVIRONMENT;
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; img-src 'self' data:",
};

// ---- Gzip-aware send ----
function sendGzip(req, res, code, data, contentType) {
  const body   = typeof data === 'string' ? data : JSON.stringify(data);
  const accepts = req.headers['accept-encoding'] || '';
  const ct = contentType || 'application/json; charset=utf-8';
  const headers = { 'Content-Type': ct, ...SEC_HEADERS };
  if (accepts.includes('gzip') && body.length > 512) {
    zlib.gzip(Buffer.from(body), (err, buf) => {
      if (err) { res.writeHead(code, headers); res.end(body); return; }
      res.writeHead(code, { ...headers, 'Content-Encoding':'gzip', 'Vary':'Accept-Encoding', 'Content-Length': buf.length });
      res.end(buf);
    });
  } else {
    res.writeHead(code, headers);
    res.end(body);
  }
}

// ---- Static file cache (ETag + gzip, сжимаем один раз и кэшируем) ----
const staticCache = new Map(); // filepath → { etag, data, gz }
const COMPRESSIBLE = new Set(['.html','.js','.css','.svg']);
function serveStatic(req, res, fp, cacheSeconds) {
  fs.stat(fp, (err, stat) => {
    if (err) { res.writeHead(404, SEC_HEADERS); res.end('Not found'); return; }
    const etag = `"${stat.mtimeMs.toString(36)}-${stat.size}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, SEC_HEADERS); res.end(); return; }
    const ext = path.extname(fp);
    const ct = MIME[ext] || 'application/octet-stream';
    const cc = cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store';
    const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip') && COMPRESSIBLE.has(ext);

    const respond = entry => {
      if (acceptsGzip && entry.gz) {
        res.writeHead(200, { 'Content-Type':ct, 'Cache-Control':cc, 'ETag':etag, 'Content-Encoding':'gzip', 'Vary':'Accept-Encoding', ...SEC_HEADERS });
        res.end(entry.gz);
      } else {
        res.writeHead(200, { 'Content-Type':ct, 'Cache-Control':cc, 'ETag':etag, ...SEC_HEADERS });
        res.end(entry.data);
      }
    };

    const cached = staticCache.get(fp);
    if (cached && cached.etag === etag) { respond(cached); return; }

    fs.readFile(fp, (err2, data) => {
      if (err2) { res.writeHead(404, SEC_HEADERS); res.end('Not found'); return; }
      if (COMPRESSIBLE.has(ext) && data.length > 512) {
        zlib.gzip(data, (gzErr, gz) => {
          const entry = { etag, data, gz: gzErr ? null : gz };
          staticCache.set(fp, entry);
          respond(entry);
        });
      } else {
        const entry = { etag, data, gz: null };
        staticCache.set(fp, entry);
        respond(entry);
      }
    });
  });
}

function hashPass(pass, salt) {
  return crypto.createHmac('sha256', salt).update(pass).digest('hex');
}
function genToken() {
  return crypto.randomBytes(32).toString('hex');
}
function getSession(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/rnp_session=([a-f0-9]{64})/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s || s.expires < Date.now()) { sessions.delete(m[1]); return null; }
  return s;
}
function setCookie(res, token) {
  const secure = IS_PROD ? '; Secure; SameSite=Strict' : '';
  res.setHeader('Set-Cookie', `rnp_session=${token}; HttpOnly; Path=/; Max-Age=2592000${secure}`);
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', 'rnp_session=; HttpOnly; Path=/; Max-Age=0');
}

// ---- Users DB ----
function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_F, 'utf8')); } catch { return []; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_F, JSON.stringify(users, null, 2));
}

// ---- Per-user DB ----
const DEFAULT_DB = {
  settings: { apiKey: '', taxRate: 7, usdRate: 90, ffStock: {} },
  products: [],
  plans: {},
  days: [],
  campaigns: [],
  log: []
};
function userDbPath(userId, cabinetId) {
  const dir = path.join(DATA, 'u', String(userId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const cid = cabinetId || 'c1';
  if (cid === 'c1') return path.join(dir, 'db.json'); // старый путь — для совместимости с уже существующими пользователями
  const cabDir = path.join(dir, 'cabinets');
  if (!fs.existsSync(cabDir)) fs.mkdirSync(cabDir, { recursive: true });
  return path.join(cabDir, cid + '.json');
}
// loadUserDB / saveUserDB определены ниже после dbCache

// ---- Demo seed ----
function seedUserDemo(userId, cabinetId) {
  const cid = cabinetId || 'c1';
  const db = loadUserDB(userId, cid);
  if (db.products.length) return; // already seeded

  const prods = [
    { id:'d01', sku:'Платье_миди_цветы',  name:'Платье миди в цветы',       category:'ПЛАТЬЯ',   cost:890,  pkg:55, commission:15, logistics:125, buyout:74, price:2790, manager:'Аня',   status:'Локомотив', planDrr:14, sizes:[{size:'XS',stock:45,inTransit:10},{size:'S',stock:120,inTransit:25},{size:'M',stock:89,inTransit:15},{size:'L',stock:34,inTransit:8},{size:'XL',stock:12,inTransit:3}] },
    { id:'d02', sku:'Топ_рибана_белый',   name:'Топ рибана белый',          category:'ВЕРХ',     cost:180,  pkg:25, commission:15, logistics:80,  buyout:84, price:790,  manager:'Аня',   status:'Локомотив', planDrr:10, sizes:[{size:'XS',stock:40,inTransit:10},{size:'S',stock:95,inTransit:25},{size:'M',stock:130,inTransit:35},{size:'L',stock:55,inTransit:12}] },
    { id:'d03', sku:'Джинсы_mom_светлые', name:'Джинсы mom fit светлые',    category:'НИЗ',      cost:1050, pkg:65, commission:15, logistics:140, buyout:77, price:3190, manager:'Дима',  status:'Рост',      planDrr:17, sizes:[{size:'XS',stock:30,inTransit:8},{size:'S',stock:85,inTransit:20},{size:'M',stock:110,inTransit:30},{size:'L',stock:65,inTransit:15},{size:'XL',stock:25,inTransit:6}] },
    { id:'d04', sku:'Ветровка_черная',    name:'Ветровка чёрная оверсайз',  category:'ВЕТРОВКИ', cost:1350, pkg:80, commission:15, logistics:160, buyout:66, price:3590, manager:'Дима',  status:'Рост',      planDrr:19, sizes:[{size:'XS',stock:20,inTransit:5},{size:'S',stock:55,inTransit:10},{size:'M',stock:78,inTransit:20},{size:'L',stock:43,inTransit:12},{size:'XL',stock:18,inTransit:5},{size:'XXL',stock:8,inTransit:2}] },
    { id:'d05', sku:'Юбка_плиссе_миди',  name:'Юбка плиссе миди бежевая',  category:'НИЗ',      cost:520,  pkg:45, commission:15, logistics:110, buyout:61, price:1790, manager:'Света', status:'Аутсайдер', planDrr:25, sizes:[{size:'XS',stock:40,inTransit:10},{size:'S',stock:95,inTransit:25},{size:'M',stock:130,inTransit:35},{size:'L',stock:55,inTransit:12}] },
    { id:'d06', sku:'Кардиган_oversize',  name:'Кардиган оверсайз вязаный', category:'ВЕРХ',     cost:1100, pkg:70, commission:15, logistics:150, buyout:71, price:2990, manager:'Света', status:'Новинка',   planDrr:20, sizes:[{size:'XS',stock:20,inTransit:5},{size:'S',stock:55,inTransit:10},{size:'M',stock:78,inTransit:20},{size:'L',stock:43,inTransit:12},{size:'XL',stock:18,inTransit:5},{size:'XXL',stock:8,inTransit:2}] },
    { id:'d07', sku:'Шорты_льняные',      name:'Шорты льняные бежевые',     category:'НИЗ',      cost:350,  pkg:35, commission:15, logistics:95,  buyout:79, price:1290, manager:'Аня',   status:'Рост',      planDrr:15, sizes:[{size:'XS',stock:40,inTransit:10},{size:'S',stock:95,inTransit:25},{size:'M',stock:130,inTransit:35},{size:'L',stock:55,inTransit:12}] },
    { id:'d08', sku:'Блузка_шелк_белая', name:'Блузка под шёлк белая',      category:'ВЕРХ',     cost:680,  pkg:50, commission:15, logistics:120, buyout:69, price:2290, manager:'Дима',  status:'Рост',      planDrr:18, sizes:[{size:'XS',stock:40,inTransit:10},{size:'S',stock:95,inTransit:25},{size:'M',stock:130,inTransit:35},{size:'L',stock:55,inTransit:12}] },
    { id:'d09', sku:'Брюки_палаццо',     name:'Брюки палаццо чёрные',       category:'НИЗ',      cost:780,  pkg:55, commission:15, logistics:130, buyout:72, price:2490, manager:'Света', status:'Новинка',   planDrr:22, sizes:[{size:'XS',stock:30,inTransit:8},{size:'S',stock:85,inTransit:20},{size:'M',stock:110,inTransit:30},{size:'L',stock:65,inTransit:15},{size:'XL',stock:25,inTransit:6}] },
    { id:'d10', sku:'Сарафан_джинс',     name:'Сарафан джинсовый синий',    category:'ПЛАТЬЯ',   cost:920,  pkg:60, commission:15, logistics:135, buyout:75, price:2690, manager:'Аня',   status:'Рост',      planDrr:16, sizes:[{size:'XS',stock:45,inTransit:10},{size:'S',stock:120,inTransit:25},{size:'M',stock:89,inTransit:15},{size:'L',stock:34,inTransit:8},{size:'XL',stock:12,inTransit:3}] },
  ];

  const profiles = {
    'Платье_миди_цветы':  { showsBase:[15000,28000], ctr:[3.2,5.8], cart:[10,18], ordRate:[4,7],   trendMo:1.12, wknd:.82, saleBoost:1.5 },
    'Топ_рибана_белый':   { showsBase:[25000,45000], ctr:[4.5,7.0], cart:[14,24], ordRate:[6,10],  trendMo:1.15, wknd:1.10, saleBoost:1.8 },
    'Джинсы_mom_светлые': { showsBase:[12000,22000], ctr:[2.8,4.8], cart:[8,15],  ordRate:[3.5,6], trendMo:1.08, wknd:.78, saleBoost:1.4 },
    'Ветровка_черная':    { showsBase:[10000,18000], ctr:[2.5,4.2], cart:[7,13],  ordRate:[3,5.5], trendMo:0.95, wknd:.75, saleBoost:1.3 },
    'Юбка_плиссе_миди':   { showsBase:[6000,11000],  ctr:[1.5,2.8], cart:[4,9],   ordRate:[1.8,3.2],trendMo:0.90, wknd:.70, saleBoost:1.2 },
    'Кардиган_oversize':  { showsBase:[5000,12000],  ctr:[1.8,3.5], cart:[5,11],  ordRate:[2,4],   trendMo:1.05, wknd:.80, saleBoost:1.1 },
    'Шорты_льняные':      { showsBase:[14000,26000], ctr:[3.5,6.0], cart:[11,20], ordRate:[5,8],   trendMo:1.20, wknd:1.15, saleBoost:1.6 },
    'Блузка_шелк_белая':  { showsBase:[9000,17000],  ctr:[2.8,4.5], cart:[8,15],  ordRate:[3.2,5.5],trendMo:1.10, wknd:.82, saleBoost:1.4 },
    'Брюки_палаццо':      { showsBase:[7000,14000],  ctr:[2.2,4.0], cart:[6,12],  ordRate:[2.5,4.5],trendMo:1.08, wknd:.80, saleBoost:1.3 },
    'Сарафан_джинс':      { showsBase:[11000,21000], ctr:[3.0,5.2], cart:[9,17],  ordRate:[4,7],   trendMo:1.18, wknd:1.05, saleBoost:1.5 },
  };

  const rng  = (a,b) => Math.random()*(b-a)+a;
  const irng = (a,b) => Math.floor(rng(a,b));

  const months = [
    { ym:'2026-04', days:30 },
    { ym:'2026-05', days:31 },
    { ym:'2026-06', days:30 },
  ];

  const days = [];
  const plans = {};

  for (const mo of months) {
    const [y, m] = mo.ym.split('-').map(Number);
    plans[mo.ym] = {};

    for (const p of prods) {
      plans[mo.ym][p.sku] = {
        ordQty: Math.round(rng(200, 900)),
        ordRub: Math.round(rng(200, 900) * p.price * 0.9),
        buyQty: Math.round(rng(150, 700))
      };
    }

    for (let d = 1; d <= mo.days; d++) {
      const date = `${mo.ym}-${String(d).padStart(2,'0')}`;
      const dow  = new Date(y, m-1, d).getDay();
      const isWknd = dow === 0 || dow === 6;
      const isMayHols = mo.ym === '2026-05' && d >= 1 && d <= 9;
      const isSale    = mo.ym === '2026-05' && d >= 11 && d <= 18;
      const moIdx = months.findIndex(x => x.ym === mo.ym); // 0,1,2
      const progress = d / mo.days;

      for (const p of prods) {
        const pr = profiles[p.sku];
        if (!pr) continue;

        const trendMult = Math.pow(pr.trendMo, progress + moIdx * 0.5);
        const wkndMult  = isWknd ? pr.wknd : 1.0;
        const holsMult  = isMayHols ? 1.35 : 1.0;
        const saleMult  = isSale ? pr.saleBoost : 1.0;
        const noise     = 0.88 + Math.random() * 0.24;

        const shows    = Math.round(irng(...pr.showsBase) * trendMult * wkndMult * holsMult * noise);
        const clicks   = Math.round(shows * rng(...pr.ctr) / 100);
        const cart     = Math.round(clicks * rng(...pr.cart) / 100);
        const ordQ     = Math.round(clicks * rng(...pr.ordRate) / 100 * saleMult);
        const buyoutPct = p.buyout / 100 * (0.92 + Math.random() * .16);
        const buyQ     = Math.max(0, Math.round(ordQ * buyoutPct));
        const spp      = isSale ? Math.round(rng(25,35)*10)/10 : Math.round(rng(8,22)*10)/10;
        const effectivePrice = p.price * (1 - spp/100);
        const ordS     = Math.round(ordQ * effectivePrice);
        const buyS     = Math.round(buyQ * effectivePrice * 0.97);
        const adsShare = p.status === 'Аутсайдер' ? 0.55 : p.status === 'Новинка' ? 0.50 : 0.35;
        const adsShows = Math.round(shows * adsShare * (0.9 + Math.random() * .2));
        const adsCtr   = p.status === 'Аутсайдер' ? rng(0.3, 0.8) : rng(0.7, 1.5);
        const adsClicks= Math.round(adsShows * adsCtr / 100);
        const adsBase  = p.status === 'Аутсайдер' ? rng(2000,5000) : rng(800, 3500);
        const adsSpend = Math.round(adsBase * (isWknd ? 0.7 : 1.0) * saleMult);
        const stock    = Math.max(5, irng(80,300) - Math.round(d * buyQ * 0.05));
        const isNewbie = p.status === 'Новинка';
        const giveaway    = mo.ym === '2026-04' && d <= 5 && isNewbie ? irng(1,5) : 0;
        const returnQ     = buyQ > 0 ? Math.round(buyQ * rng(0.03, 0.12)) : 0;
        const storageCost = Math.round(stock * rng(0.5, 2.0));

        days.push({
          id: `demo_${p.sku}_${date}`,
          date, sku: p.sku,
          ordQ, ordS, buyQ, buyS, stock, shows, clicks, cart,
          adsShows, adsClicks, adsSpend, spp, giveaway,
          returnQ, storageCost,
          source: 'demo'
        });
      }
    }
  }

  db.products = prods;
  db.days     = days;
  db.plans    = plans;
  db.settings = { apiKey:'', taxRate:7, usdRate:90 };
  addLog(db, '🎉 Демо-кабинет загружен: 10 товаров, 3 месяца данных (апрель–июнь 2026). Замени на свои!');
  saveUserDB(userId, cid, db);
}

function addLog(db, msg) {
  db.log.unshift({ t: new Date().toISOString(), msg });
  db.log = db.log.slice(0, 200);
}

// ---- Init demo user ----
function ensureDemoUser() {
  const users = loadUsers();
  if (users.find(u => u.email === 'demo@rnp.ru')) return;
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: 'demo',
    email: 'demo@rnp.ru',
    name: 'Демо-магазин',
    passHash: hashPass('demo123', salt),
    salt,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  saveUsers(users);
  seedUserDemo('demo');
  console.log('✅ Демо-пользователь создан: demo@rnp.ru / demo123');
}

// ---- WB Statistics API ----
const WB_BASE = 'https://statistics-api.wildberries.ru';
const WB_CONTENT = 'https://content-api.wildberries.ru';
const WB_PRICES = 'https://discounts-prices-api.wildberries.ru';
async function wbGet(key, urlPath, base) {
  const res = await fetch((base||WB_BASE) + urlPath, { headers: { Authorization: 'Bearer ' + key.replace(/^Bearer\s*/i,'') } });
  if (!res.ok) throw new Error('WB ' + res.status + ' ' + (await res.text()).slice(0, 200));
  return res.json();
}

// ---- WB Content API: fetch product cards ----
async function wbGetCards(key) {
  const token = key.replace(/^Bearer\s*/i,'');
  let cards = [], cursor = {};
  for (let i = 0; i < 20; i++) { // max 20 pages × 100 = 2000 cards
    const body = JSON.stringify({ settings:{ cursor: { ...cursor, limit:100 }, filter:{ withPhoto:-1 } } });
    const res = await fetch(WB_CONTENT + '/content/v2/get/cards/list', {
      method:'POST', headers:{ Authorization:'Bearer '+token, 'Content-Type':'application/json' }, body
    });
    if (!res.ok) break;
    const d = await res.json();
    const batch = d.cards || [];
    cards = cards.concat(batch);
    if (!d.cursor || batch.length < 100) break;
    cursor = { updatedAt: d.cursor.updatedAt, nmID: d.cursor.nmID };
  }
  return cards;
}

// ---- WB Prices API: fetch current selling price per nmID ----
// content-api cards/list does NOT return price — it lives on a separate service.
async function wbGetPrices(key) {
  const token = key.replace(/^Bearer\s*/i,'');
  const priceByNm = {};
  let offset = 0;
  for (let i = 0; i < 20; i++) { // max 20 pages × 1000
    const res = await fetch(`${WB_PRICES}/api/v2/list/goods/filter?limit=1000&offset=${offset}`, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!res.ok) break;
    const d = await res.json();
    const goods = d.data?.listGoods || [];
    goods.forEach(g => {
      const sz = g.sizes?.[0];
      if (sz) priceByNm[String(g.nmID)] = sz.discountedPrice || sz.price || 0;
    });
    if (goods.length < 1000) break;
    offset += 1000;
  }
  return priceByNm;
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
    if (!map[k]) map[k] = { date, sku, ordQ:0, ordS:0, buyQ:0, buyS:0, stock:0, shows:0, clicks:0, cart:0, adsShows:0, adsClicks:0, adsSpend:0, spp:0, giveaway:0, returnQ:0, storageCost:0 };
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
      db.products.push({ id:'p'+Date.now()+Math.random().toString(36).slice(2,6), sku, wbId:'', name:sku, cost:0, pkg:0, commission:15, logistics:0, buyout:70, price:0, manager:'', status:'НЕ ВЫБРАНО', planDrr:0 });
    }
  });

  db.days = db.days.filter(d => d.source !== 'wb' || d.date < dateFrom);
  Object.values(map).forEach(b => { db.days.push({ id:'wb'+b.date+b.sku, ...b, source:'wb' }); });
  out.days = Object.keys(map).length;
  addLog(db, `Синк WB: заказы ${out.orders}, выкупы ${out.sales}, остатки ${out.stocks}, дней·SKU ${out.days}`);
  return out;
}

// ---- HTTP helpers ----
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.png':'image/png' };

function send(res, code, data, type) {
  const body = Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data);
  const headers = { 'Content-Type': type || 'application/json; charset=utf-8', ...SEC_HEADERS };
  res.writeHead(code, headers);
  res.end(body);
}
function body(req) {
  return new Promise(r => { let b=''; req.on('data', c => b+=c); req.on('end', () => { try { r(JSON.parse(b||'{}')); } catch { r({}); } }); });
}
function redirect(res, url) {
  res.writeHead(302, { Location: url });
  res.end();
}

// ---- Server ----
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  // ---- Auth endpoints (no session required) ----
  if ((p === '/api/auth/register' || p === '/api/auth/login') && req.method === 'POST') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || 'unknown';
    if (rateLimit(ip)) return send(res, 429, { ok:false, msg:'Слишком много запросов. Подождите минуту.' });
  }
  if (p === '/api/auth/register' && req.method === 'POST') {
    const b = await body(req);
    const { email, name, password } = b;
    if (!email || !name || !password) return send(res, 200, { ok:false, msg:'Заполни все поля' });
    const users = loadUsers();
    if (users.find(u => u.email === email)) return send(res, 200, { ok:false, msg:'Email уже занят' });
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: genToken().slice(0,12), email, name, passHash: hashPass(password, salt), salt, createdAt: new Date().toISOString() };
    users.push(user);
    saveUsers(users);
    // новый пользователь начинает с чистого листа (не seedUserDemo)
    const token = genToken();
    sessions.set(token, { userId: user.id, email: user.email, name: user.name, expires: Date.now() + 30*24*3600*1000 });
    setCookie(res, token);
    return send(res, 200, { ok:true, token, user: { id:user.id, email:user.email, name:user.name } });
  }

  if (p === '/api/auth/login' && req.method === 'POST') {
    const b = await body(req);
    const { email, password } = b;
    const users = loadUsers();
    const user = users.find(u => u.email === email);
    if (!user || hashPass(password, user.salt) !== user.passHash) return send(res, 200, { ok:false, msg:'Неверный email или пароль' });
    const token = genToken();
    sessions.set(token, { userId: user.id, email: user.email, name: user.name, expires: Date.now() + 30*24*3600*1000 });
    setCookie(res, token);
    return send(res, 200, { ok:true, token, user: { id:user.id, email:user.email, name:user.name } });
  }

  if (p === '/api/auth/logout' && req.method === 'POST') {
    const cookie = req.headers.cookie || '';
    const m = cookie.match(/rnp_session=([a-f0-9]{64})/);
    if (m) sessions.delete(m[1]);
    clearCookie(res);
    return send(res, 200, { ok:true });
  }

  if (p === '/api/auth/me' && req.method === 'GET') {
    const sess = getSession(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' });
    return send(res, 200, { user: { id:sess.userId, email:sess.email, name:sess.name } });
  }

  // ---- FX: актуальный курс USD и других валют (ЦБ РФ, публичный API, без ключа) ----
  if (p === '/api/fx/rates' && req.method === 'GET') {
    try {
      const r = await fetch('https://www.cbr-xml-daily.ru/daily_json.js');
      if (!r.ok) throw new Error('CBR ' + r.status);
      const d = await r.json();
      const usd = d.Valute?.USD?.Value;
      const eur = d.Valute?.EUR?.Value;
      const kgs = d.Valute?.KGS ? d.Valute.KGS.Value / (d.Valute.KGS.Nominal || 1) : null;
      if (!usd) throw new Error('нет данных USD');
      return send(res, 200, { ok:true, usd: Math.round(usd*100)/100, eur: eur ? Math.round(eur*100)/100 : null, kgs, date: d.Date });
    } catch(e) { return send(res, 200, { ok:false, msg: 'Не удалось получить курс: ' + e.message }); }
  }

  if (p === '/api/load-demo' && req.method === 'POST') {
    const sess = getSession(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' });
    const meta = loadCabinetsMeta(sess.userId);
    seedUserDemo(sess.userId, meta.activeId);
    return send(res, 200, { ok:true });
  }

  // ---- Demo auto-login ----
  if (p === '/demo') {
    ensureDemoUser(); // создать если нет (после рестарта Railway)
    const users = loadUsers();
    let user = users.find(u => u.email === 'demo@rnp.ru');
    if (!user) {
      // крайний случай — создать прямо сейчас
      const salt = crypto.randomBytes(16).toString('hex');
      user = { id:'demo', email:'demo@rnp.ru', name:'Демо-магазин', passHash:hashPass('demo123',salt), salt, createdAt:new Date().toISOString() };
      users.push(user); saveUsers(users); seedUserDemo('demo');
    }
    const token = genToken();
    sessions.set(token, { userId: user.id, email: user.email, name: user.name, expires: Date.now() + 30*24*3600*1000 });
    setCookie(res, token);
    return redirect(res, '/');
  }

  // ---- Static files (login.html always available) ----
  if (p === '/login.html') {
    return serveStatic(req, res, path.join(PUB, 'login.html'), 0);
  }

  // ---- Root: redirect to login if no session ----
  if (p === '/') {
    const sess = getSession(req);
    if (!sess) return redirect(res, '/login.html');
    return serveStatic(req, res, path.join(PUB, 'index.html'), 0);
  }

  // ---- Protected API endpoints ----
  if (p.startsWith('/api/')) {
    const sess = getSession(req);
    if (!sess) return send(res, 401, { error: 'unauthorized' });
    const userId = sess.userId;
    const meta = loadCabinetsMeta(userId);

    try {
      // ---- Управление кабинетами (несколько магазинов WB в одном логине) ----
      if (p === '/api/cabinets' && req.method === 'GET') {
        return send(res, 200, { activeId: meta.activeId, list: meta.list });
      }

      if (p === '/api/cabinets/create' && req.method === 'POST') {
        const b = await body(req);
        const name = (b.name || '').trim() || `Кабинет ${meta.list.length + 1}`;
        const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
        meta.list.push({ id, name, createdAt: new Date().toISOString() });
        meta.activeId = id;
        saveCabinetsMeta(userId, meta);
        saveUserDB(userId, id, JSON.parse(JSON.stringify(DEFAULT_DB))); // создаём пустой файл кабинета сразу
        return send(res, 200, { ok:true, activeId: id, list: meta.list });
      }

      if (p === '/api/cabinets/switch' && req.method === 'POST') {
        const b = await body(req);
        const exists = meta.list.find(c => c.id === b.id);
        if (!exists) return send(res, 200, { ok:false, msg:'Кабинет не найден' });
        meta.activeId = b.id;
        saveCabinetsMeta(userId, meta);
        return send(res, 200, { ok:true, activeId: meta.activeId, list: meta.list });
      }

      if (p === '/api/cabinets/rename' && req.method === 'POST') {
        const b = await body(req);
        const c = meta.list.find(c => c.id === b.id);
        if (!c) return send(res, 200, { ok:false, msg:'Кабинет не найден' });
        c.name = (b.name || '').trim() || c.name;
        saveCabinetsMeta(userId, meta);
        return send(res, 200, { ok:true, list: meta.list });
      }

      if (p === '/api/cabinets/delete' && req.method === 'POST') {
        const b = await body(req);
        if (meta.list.length <= 1) return send(res, 200, { ok:false, msg:'Нельзя удалить единственный кабинет' });
        const idx = meta.list.findIndex(c => c.id === b.id);
        if (idx < 0) return send(res, 200, { ok:false, msg:'Кабинет не найден' });
        meta.list.splice(idx, 1);
        if (meta.activeId === b.id) meta.activeId = meta.list[0].id;
        saveCabinetsMeta(userId, meta);
        // Мягкое удаление — файл не стираем, а переименовываем, данные восстановимы
        try {
          const fp = userDbPath(userId, b.id);
          if (fs.existsSync(fp)) fs.renameSync(fp, fp + '.trash');
        } catch {}
        dbCache.delete(userId + '::' + b.id);
        return send(res, 200, { ok:true, activeId: meta.activeId, list: meta.list });
      }

      const cabinetId = meta.activeId;
      const db = loadUserDB(userId, cabinetId);

      if (p === '/api/state' && req.method === 'GET') {
        return sendGzip(req, res, 200, { ...db, _cabinets: meta.list, _activeCabinetId: cabinetId });
      }

      if (p === '/api/save' && req.method === 'POST') {
        const b = await body(req);
        ['settings','products','plans','days','campaigns'].forEach(k => { if (b[k] !== undefined) db[k] = b[k]; });
        saveUserDB(userId, cabinetId, db);
        return send(res, 200, { ok:true });
      }

      if (p === '/api/wb/test' && req.method === 'POST') {
        const b = await body(req);
        const key = b.apiKey || db.settings.apiKey;
        if (!key) return send(res, 200, { ok:false, msg:'Нет API-ключа' });
        try {
          const today = new Date().toISOString().slice(0, 10);
          const o = await wbGet(key, `/api/v1/supplier/orders?dateFrom=${today}&flag=1`);
          return send(res, 200, { ok:true, msg:`Подключение успешно. Заказов за сегодня: ${o.length}` });
        } catch(e) { return send(res, 200, { ok:false, msg:'Ошибка: '+e.message }); }
      }

      if (p === '/api/wb/sync' && req.method === 'POST') {
        const b = await body(req);
        const key = b.apiKey || db.settings.apiKey;
        if (!key) return send(res, 200, { ok:false, msg:'Нет API-ключа' });
        if (b.apiKey) db.settings.apiKey = b.apiKey;
        const dateFrom = b.dateFrom || new Date(Date.now() - 30*864e5).toISOString().slice(0, 10);
        try {
          const r = await wbSync(db, key, dateFrom);
          saveUserDB(userId, cabinetId, db);
          return send(res, 200, { ok:true, msg:`Готово. Заказы ${r.orders}, выкупы ${r.sales}, остатки ${r.stocks}`, result:r });
        } catch(e) {
          addLog(db, 'Ошибка синка: '+e.message);
          saveUserDB(userId, cabinetId, db);
          return send(res, 200, { ok:false, msg:e.message });
        }
      }

      if (p === '/api/archive/save' && req.method === 'POST') {
        const b = await body(req);
        if (!b.ym) return send(res, 200, { ok:false, msg:'Нет ym' });
        const userArcDir = archiveDirFor(userId, cabinetId);
        if (!fs.existsSync(userArcDir)) fs.mkdirSync(userArcDir, { recursive: true });
        const file = path.join(userArcDir, b.ym+'.json');
        fs.writeFileSync(file, JSON.stringify(b, null, 2));
        return send(res, 200, { ok:true, file });
      }

      if (p === '/api/archive/list' && req.method === 'GET') {
        const userArcDir = archiveDirFor(userId, cabinetId);
        if (!fs.existsSync(userArcDir)) return send(res, 200, []);
        const files = fs.readdirSync(userArcDir).filter(f => f.endsWith('.json')).sort().reverse();
        const list = files.map(f => {
          try { const d = JSON.parse(fs.readFileSync(path.join(userArcDir, f), 'utf8')); return { ym:d.ym, name:d.name, savedAt:d.savedAt, days:d.days?.length }; }
          catch { return { ym:f.replace('.json','') }; }
        });
        return send(res, 200, list);
      }

      if (p.startsWith('/api/archive/view') && req.method === 'GET') {
        const ym = u.searchParams.get('ym');
        const userArcDir = archiveDirFor(userId, cabinetId);
        const file = path.join(userArcDir, (ym||'')+'.json');
        if (!ym || !fs.existsSync(file)) return send(res, 404, { error:'not found' });
        return send(res, 200, JSON.parse(fs.readFileSync(file, 'utf8')));
      }

      // ---- WB: import product cards ----
      if (p === '/api/wb/cards' && req.method === 'POST') {
        const b = await body(req);
        const key = b.apiKey || db.settings.apiKey;
        if (!key) return send(res, 200, { ok:false, msg:'Нет API-ключа WB' });
        try {
          const [cards, priceByNm] = await Promise.all([
            wbGetCards(key),
            wbGetPrices(key).catch(() => ({})) // цены — best-effort, не роняем импорт если недоступно
          ]);
          let added = 0, updated = 0, needCost = 0;
          cards.forEach(card => {
            const sku = card.vendorCode || String(card.nmID);
            const name = (card.title || card.subjectName || sku).slice(0, 80);
            const nmId = String(card.nmID || '');
            const price = priceByNm[nmId] || card.sizes?.[0]?.price || 0;
            const existing = db.products.find(p => p.sku === sku || p.wbId === nmId);
            if (existing) {
              existing.name = existing.name || name;
              existing.wbId = existing.wbId || nmId;
              if (price && !existing.price) existing.price = price;
              if (!existing.cost) needCost++;
              updated++;
            } else {
              db.products.push({ id:'wb'+nmId, sku, wbId:nmId, name, cost:0, pkg:0, commission:15, logistics:80, buyout:75, price, manager:'', status:'НЕ ВЫБРАНО', planDrr:15, category:'' });
              added++; needCost++;
            }
          });
          if (b.apiKey) db.settings.apiKey = b.apiKey;
          saveUserDB(userId, cabinetId, db);
          const costMsg = needCost > 0 ? ` ⚠️ У ${needCost} товаров нет себестоимости — заполни вручную в таблице «Товары и план».` : '';
          return send(res, 200, { ok:true, added, updated, needCost, total:cards.length, msg:`Загружено ${cards.length} товаров: +${added} новых, ${updated} обновлено.${costMsg}` });
        } catch(e) { return send(res, 200, { ok:false, msg:'Ошибка WB API: ' + e.message }); }
      }

      // ---- Import cost prices from CSV ----
      if (p === '/api/import/costs' && req.method === 'POST') {
        const b = await body(req);
        const rows = b.rows || []; // [{sku, cost, price, commission, logistics, pkg}]
        let updated = 0;
        rows.forEach(r => {
          const prod = db.products.find(p => p.sku === r.sku || p.wbId === r.sku || p.name === r.sku);
          if (!prod) return;
          if (r.cost      !== undefined && r.cost      !== '') prod.cost       = parseFloat(r.cost)||0;
          if (r.price     !== undefined && r.price     !== '') prod.price      = parseFloat(r.price)||0;
          if (r.commission!== undefined && r.commission!== '') prod.commission = parseFloat(r.commission)||0;
          if (r.logistics !== undefined && r.logistics !== '') prod.logistics  = parseFloat(r.logistics)||0;
          if (r.pkg       !== undefined && r.pkg       !== '') prod.pkg        = parseFloat(r.pkg)||0;
          if (r.planDrr   !== undefined && r.planDrr   !== '') prod.planDrr   = parseFloat(r.planDrr)||0;
          updated++;
        });
        saveUserDB(userId, cabinetId, db);
        return send(res, 200, { ok:true, updated, msg:`Обновлено ${updated} товаров` });
      }

      return send(res, 404, { error:'not found' });
    } catch(e) { return send(res, 500, { error:e.message }); }
  }

  // ---- Other static files (JS/CSS — ETag + no-cache для гарантии обновлений) ----
  const fp = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  return serveStatic(req, res, fp, 0);
});

ensureDemoUser();
server.listen(PORT, '0.0.0.0', () => console.log(`РНП запущена → http://localhost:${PORT}`));
