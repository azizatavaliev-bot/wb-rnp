// РНП v5 — точная копия структуры Google Sheets
const App = (() => {
  let db = { settings: { taxRate: 7, usdRate: 90 }, products: [], plans: {}, days: [], campaigns: [], log: [] };
  const $ = id => document.getElementById(id);

  // ---- utils ----
  const fmt = (n, dec=0) => (n == null || isNaN(n) || !isFinite(n)) ? '' : n.toLocaleString('ru', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmtP = (n, dec=1) => (n == null || isNaN(n) || !isFinite(n)) ? '' : fmt(n, dec) + '%';
  const uid  = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const curMonth = () => $('month').value || new Date().toISOString().slice(0, 7);
  const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ---- data ----
  async function load() {
    try {
      const r = await fetch('/api/state'); db = await r.json();
      if (!db.settings) db.settings = {};
      ['products','days','log'].forEach(k => { if (!Array.isArray(db[k])) db[k] = []; });
      if (!db.plans) db.plans = {};
    } catch { toast('Ошибка загрузки'); }
  }
  async function save() {
    await fetch('/api/save', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(db) });
  }

  // ---- month / weeks ----
  function weeksOf(ym) {
    const [y,m] = ym.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const firstDow = new Date(y, m-1, 1).getDay(); // 0=sun
    const weeks = [[],[],[],[],[]];
    for (let d = 1; d <= daysInMonth; d++) {
      const wi = clamp(Math.floor((d + firstDow - 2) / 7), 0, 4);
      weeks[wi].push(d);
    }
    return { weeks: weeks.filter(w => w.length), daysInMonth };
  }

  // ---- aggregation ----
  function factOf(allDays, sku, dates) {
    const sub = allDays.filter(d => d.sku === sku && (!dates || dates.includes(d.date)));
    const sum = f => sub.reduce((a,d) => a + (Number(d[f])||0), 0);
    const avg = f => sub.length ? sum(f)/sub.length : 0;
    const last = f => { const s = sub.slice().sort((a,b)=>a.date>b.date?1:-1); return s.length ? (Number(s[s.length-1][f])||0) : 0; };
    const adsSpend = sum('adsSpend') || sum('ads');
    return { ordQ:sum('ordQ'), ordS:sum('ordS'), buyQ:sum('buyQ'), buyS:sum('buyS'),
      stock:last('stock'), shows:sum('shows'), clicks:sum('clicks'), cart:sum('cart'),
      adsShows:sum('adsShows'), adsClicks:sum('adsClicks'), adsSpend,
      spp:avg('spp'), giveaway:sum('giveaway'),
      returnQ:sum('returnQ'), storageCost:sum('storageCost'), n:sub.length };
  }

  function factAllOf(monthDays, skus, dates) {
    const z = {ordQ:0,ordS:0,buyQ:0,buyS:0,stock:0,shows:0,clicks:0,cart:0,adsShows:0,adsClicks:0,adsSpend:0,spp:0,giveaway:0,returnQ:0,storageCost:0,n:0};
    for (const sku of skus) {
      const f = factOf(monthDays, sku, dates);
      z.ordQ+=f.ordQ; z.ordS+=f.ordS; z.buyQ+=f.buyQ; z.buyS+=f.buyS;
      z.stock+=f.stock; z.shows+=f.shows; z.clicks+=f.clicks; z.cart+=f.cart;
      z.adsShows+=f.adsShows; z.adsClicks+=f.adsClicks; z.adsSpend+=f.adsSpend;
      z.giveaway+=f.giveaway; z.returnQ+=f.returnQ; z.storageCost+=f.storageCost; z.n+=f.n;
    }
    const sppNum = skus.reduce((a,sku) => { const f=factOf(monthDays,sku,dates); return a+f.spp*f.buyQ; }, 0);
    z.spp = z.buyQ>0 ? sppNum/z.buyQ : 0;
    return z;
  }

  function econAllOf(monthDays, products, dates, tax) {
    let kPerech=0, profit=0, adsSpend=0, buyS=0, buyQ=0, ordQ=0, shows=0, clicks=0;
    for (const p of products) {
      const f = factOf(monthDays, p.sku, dates);
      const e = econOf(f, p, tax);
      kPerech += e.kPerech;
      profit  += e.profit;
      adsSpend += f.adsSpend;
      buyS  += f.buyS;
      buyQ  += f.buyQ;
      ordQ  += f.ordQ;
      shows += f.shows;
      clicks += f.clicks;
    }
    return {
      kPerech, profit, adsSpend,
      drr:    buyS>0  ? adsSpend/buyS*100    : 0,
      margin: buyS>0  ? profit/buyS*100      : 0,
      ctr:    shows>0 ? clicks/shows*100     : 0,
      buyoutPct: ordQ>0 ? buyQ/ordQ*100 : 0,
      ordQ, buyQ, buyS, shows, clicks
    };
  }

  function econOf(f, p, tax) {
    const rev  = f.buyS;
    const comm = rev * (p.commission||0) / 100;
    const log  = (p.logistics||0) * f.buyQ;
    const kp   = rev - comm - log;
    const costT = (p.cost||0) * f.buyQ;
    const pkgT  = (p.pkg||0) * f.buyQ;
    const taxT  = kp * (tax||0) / 100;
    const profit = kp - costT - pkgT - taxT - f.adsSpend;
    const kPerechPer = f.buyQ>0 ? kp/f.buyQ : 0;
    const profitPer  = f.buyQ>0 ? profit/f.buyQ : 0;
    const logPct     = rev>0 ? log/rev*100 : 0;
    const wbSharePct = rev>0 ? (comm+log)/rev*100 : 0;
    const wbDrrPct   = rev>0 ? (comm+log+f.adsSpend)/rev*100 : 0;
    const returnPct  = f.buyQ>0 ? (f.returnQ||0)/f.buyQ*100 : 0;
    const storePct   = rev>0 ? (f.storageCost||0)/rev*100 : 0;
    return {
      kPerech : kp, kPerechPer,
      rentab  : costT>0 ? kp/costT*100 : 0,
      margin  : rev>0 ? profit/rev*100 : 0,
      drr     : f.buyS>0 ? f.adsSpend/f.buyS*100 : 0,
      profit, profitPer,
      logPct, wbSharePct, wbDrrPct, returnPct, storePct,
      buyoutPct : f.ordQ>0 ? f.buyQ/f.ordQ*100 : (p.buyout||0),
      avgCheck  : f.ordQ>0 ? f.ordS/f.ordQ : 0,
      ctr    : f.shows>0  ? f.clicks/f.shows*100   : 0,
      cartPct: f.clicks>0 ? f.cart/f.clicks*100     : 0,
      cro    : f.clicks>0 ? f.ordQ/f.clicks*100     : 0,
      ordPct : f.clicks>0 ? f.ordQ/f.clicks*100     : 0,
      ctrRk  : f.adsShows>0  ? f.adsClicks/f.adsShows*100 : 0,
      croRk  : f.adsClicks>0 ? f.buyQ/f.adsClicks*100     : 0,
      cpc    : f.adsClicks>0 ? f.adsSpend/f.adsClicks     : 0,
    };
  }

  // ---- SVG sparkline ----
  function sparkline(values, w=80, h=22, color) {
    const v = values.filter(x => x != null && !isNaN(x));
    if (v.length < 2) return '<svg width="'+w+'" height="'+h+'"></svg>';
    const min = Math.min(...v), max = Math.max(...v);
    const range = max - min || 1;
    const xs = v.map((_,i) => (i/(v.length-1))*w);
    const ys = v.map(x => h - ((x-min)/range)*(h-2) - 1);
    const pts = xs.map((x,i) => x+','+ys[i]).join(' ');
    const clr = color || (v[v.length-1] >= v[0] ? '#1e8e3e' : '#d93025');
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <polyline points="${pts}" fill="none" stroke="${clr}" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
  }

  // ---- Category filter ----
  let activeCategory = null;

  function buildCategoryTabs() {
    const cats = [...new Set(db.products.map(p => p.category).filter(Boolean))].sort();
    const tabs = $('sheetTabs');
    if (!tabs) return;
    // Удалить старые cat-tab
    tabs.querySelectorAll('.cat-tab').forEach(t => t.remove());
    if (!cats.length) return;
    // Вставить перед кнопкой настроек
    const settingsTab = tabs.querySelector('[data-p="settings"]');
    cats.forEach(cat => {
      const btn = document.createElement('button');
      btn.className = 'sheet-tab cat-tab';
      btn.dataset.p = 'rnp';
      btn.dataset.cat = cat;
      btn.textContent = cat;
      btn.addEventListener('click', () => filterByCategory(cat, btn));
      tabs.insertBefore(btn, settingsTab);
    });
  }

  function filterByCategory(cat, btn) {
    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    $('p-rnp').classList.add('active');
    activeCategory = cat;
    render();
  }

  // ---- render ----
  function renderRnp() {
    const ym = curMonth();
    const [y,m] = ym.split('-').map(Number);
    const { weeks, daysInMonth } = weeksOf(ym);
    const planM = db.plans[ym] || {};
    const tax = db.settings?.taxRate || 7;
    const usd = db.settings?.usdRate || 90;
    const monthDays = db.days.filter(d => d.date?.startsWith(ym));
    const monthDates = Array.from({length:daysInMonth}, (_,i) => `${ym}-${String(i+1).padStart(2,'0')}`);

    const filteredProducts = activeCategory
      ? db.products.filter(p => p.category === activeCategory)
      : db.products;

    if (!filteredProducts.length) {
      $('rnpEmpty').style.display = ''; $('rnpBlocks').innerHTML = '';
      const kpiRow = $('rnpKpi'); if(kpiRow) kpiRow.style.display = 'none';
      return;
    }
    $('rnpEmpty').style.display = 'none';
    try {
      // KPI-панель вверху (всегда, для всех продуктов)
      const kpiRow = $('rnpKpi');
      if (kpiRow) {
        const allSkus = filteredProducts.map(p => p.sku);
        const totF = factAllOf(monthDays, allSkus, null);
        const totE = econAllOf(monthDays, filteredProducts, null, tax);
        kpiRow.style.display = 'grid';
        $('kpiOrdQ').textContent = fmt(totF.ordQ) + ' шт';
        $('kpiOrdS').textContent = fmt(totF.ordS) + ' ₽';
        $('kpiBuyQ').textContent = fmt(totF.buyQ) + ' шт';
        $('kpiBuyS').textContent = fmt(totF.buyS) + ' ₽';
        $('kpiKp').textContent = fmt(totE.kPerech) + ' ₽';
        $('kpiMargin').textContent = 'Маржа ' + fmtP(totE.margin);
        $('kpiProfit').textContent = fmt(totE.profit) + ' ₽';
        $('kpiDrr').textContent = 'ДРР ' + fmtP(totE.drr);
        $('kpiShows').textContent = fmt(totF.shows);
        $('kpiCtr').textContent = 'CTR ' + fmtP(totF.shows>0 ? totF.clicks/totF.shows*100 : 0, 1);
        const buyoutPct = totF.ordQ>0 ? totF.buyQ/totF.ordQ*100 : 0;
        $('kpiBuyout').textContent = fmtP(buyoutPct, 1);
        $('kpiStock').textContent = 'Остаток ' + fmt(totF.stock) + ' шт';
      }

      let summaryHtml = '';
      if (filteredProducts.length > 1) {
        summaryHtml = buildSummaryBlock(filteredProducts, ym, weeks, daysInMonth, monthDays, monthDates, tax, usd);
      }
      const prodSep = i => i > 0 ? `<div class="prod-sep"><span>товар ${i+1} из ${filteredProducts.length}</span></div>` : '';
      $('rnpBlocks').innerHTML = summaryHtml + filteredProducts.map((p, i) =>
        prodSep(i) + buildProdBlock(p, ym, weeks, daysInMonth, monthDays, monthDates, planM, tax, usd)
      ).join('');
    } catch(e) {
      $('rnpBlocks').innerHTML = `<div style="padding:40px;color:#d93025;font-size:13px">⚠️ Ошибка рендера: ${e.message}<br><pre style="font-size:11px;margin-top:8px">${e.stack}</pre></div>`;
    }
  }

  function buildSummaryBlock(products, ym, weeks, daysInMonth, monthDays, monthDates, tax, usd) {
    const [y, m] = ym.split('-').map(Number);
    const skus = products.map(p => p.sku);

    const fTotAll = factAllOf(monthDays, skus, null);
    const eTotAll = econAllOf(monthDays, products, null, tax);

    // per-week
    const wkFAll = weeks.map(wDays => factAllOf(monthDays, skus, wDays.map(d=>`${ym}-${String(d).padStart(2,'0')}`)));
    const wkEAll = weeks.map(wDays => econAllOf(monthDays, products, wDays.map(d=>`${ym}-${String(d).padStart(2,'0')}`), tax));

    // per-day
    const dayFAll = monthDates.map(date => factAllOf(monthDays, skus, [date]));
    const dayEAll = monthDates.map(date => econAllOf(monthDays, products, [date], tax));

    // avg (per recorded day)
    const uniqDatesAll = [...new Set(monthDays.map(d=>d.date))];
    const cntAll = uniqDatesAll.length || 1;
    const avgFAll = {
      ordQ:fTotAll.ordQ/cntAll, ordS:fTotAll.ordS/cntAll, buyQ:fTotAll.buyQ/cntAll, buyS:fTotAll.buyS/cntAll,
      shows:fTotAll.shows/cntAll, clicks:fTotAll.clicks/cntAll, cart:fTotAll.cart/cntAll,
      adsShows:fTotAll.adsShows/cntAll, adsClicks:fTotAll.adsClicks/cntAll, adsSpend:fTotAll.adsSpend/cntAll,
      spp:fTotAll.spp, giveaway:fTotAll.giveaway/cntAll, stock:fTotAll.stock, n:1
    };
    const avgEAll = econAllOf(monthDays, products, null, tax); // just use total ratios for avg display
    // avg econ per day
    const avgEAllDay = {
      kPerech: eTotAll.kPerech/cntAll, profit: eTotAll.profit/cntAll,
      drr: eTotAll.drr, margin: eTotAll.margin, ctr: eTotAll.ctr,
      buyoutPct: eTotAll.buyoutPct,
      ctrRk: fTotAll.adsShows>0 ? fTotAll.adsClicks/fTotAll.adsShows*100 : 0,
      ordPct: fTotAll.clicks>0 ? fTotAll.ordQ/fTotAll.clicks*100 : 0,
      cartPct: fTotAll.clicks>0 ? fTotAll.cart/fTotAll.clicks*100 : 0,
      cro: fTotAll.shows>0 ? fTotAll.ordQ/fTotAll.shows*100 : 0,
      cpc: fTotAll.adsClicks>0 ? fTotAll.adsSpend/fTotAll.adsClicks : 0,
      croRk: fTotAll.adsClicks>0 ? fTotAll.buyQ/fTotAll.adsClicks*100 : 0,
      avgCheck: fTotAll.ordQ>0 ? fTotAll.ordS/fTotAll.ordQ : 0,
    };

    const today = new Date().toISOString().slice(0,10);
    const dayNums = Array.from({length:daysInMonth}, (_,i)=>i+1);
    const WK = 5;
    const totalCols = 1 + 1 + 1 + WK + 1 + daysInMonth;

    // -- HEADER --
    const kPerechUsd = usd>0 ? eTotAll.kPerech/usd : 0;
    const header = `<div class="ph ph-summary">
      <table class="ph-t"><tbody>
        <tr>
          <td class="ph-name ph-name-sum" rowspan="3">📊 СВОДНАЯ<br><span class="ph-sub">${products.length} товаров · ${ym}</span></td>
          <td class="ph-lbl">К перечислению</td><td class="ph-val">${fmt(eTotAll.kPerech)} ₽</td>
          <td class="ph-lbl">ДРР %</td><td class="ph-val ${eTotAll.drr>25?'r':'g'}">${fmtP(eTotAll.drr)}</td>
          <td class="ph-lbl">Маржа %</td><td class="ph-val ${eTotAll.margin<0?'r':'g'}">${fmtP(eTotAll.margin)}</td>
          <td class="ph-lbl">Прибыль</td><td class="ph-val ${eTotAll.profit<0?'r':'g'}">${fmt(eTotAll.profit)} ₽</td>
          <td class="ph-lbl">CTR %</td><td class="ph-val">${fmtP(eTotAll.ctr,2)}</td>
        </tr>
        <tr>
          <td class="ph-lbl">В деньгах</td><td class="ph-val">${fmt(eTotAll.kPerech)} ₽</td>
          <td class="ph-lbl">Выкупы, шт</td><td class="ph-val">${fmt(fTotAll.buyQ)}</td>
          <td class="ph-lbl">Выкуп %</td><td class="ph-val">${fmtP(eTotAll.buyoutPct)}</td>
          <td class="ph-lbl">Остаток (сумма)</td><td class="ph-val">${fmt(fTotAll.stock)} шт</td>
          <td class="ph-lbl">Заказов, шт</td><td class="ph-val">${fmt(fTotAll.ordQ)}</td>
        </tr>
        <tr>
          <td class="ph-lbl">В долларах</td><td class="ph-val">${fmt(kPerechUsd,0)} $</td>
          <td class="ph-lbl">Показы</td><td class="ph-val">${fmt(fTotAll.shows)}</td>
          <td class="ph-lbl">Клики</td><td class="ph-val">${fmt(fTotAll.clicks)}</td>
          <td class="ph-lbl">Реклама ₽</td><td class="ph-val">${fmt(fTotAll.adsSpend)}</td>
          <td class="ph-lbl">Выручка ₽</td><td class="ph-val">${fmt(fTotAll.buyS)}</td>
        </tr>
      </tbody></table>
    </div>`;

    // col headers (same as buildProdBlock)
    const wkThs = Array.from({length:WK}, (_,i) => `<th class="c-wk">Нед. ${i+1}</th>`).join('');
    const DOW = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayDow = dayNums.map(d => new Date(y, m-1, d).getDay());
    // For summary: day has data if ANY product has data that day
    const hasSummDates = new Set(monthDays.map(d=>d.date));
    const dayThs = dayNums.map((d, i) => {
      const date = `${ym}-${String(d).padStart(2,'0')}`;
      const dw = dayDow[i];
      const dow = DOW[dw];
      const isPast = date < today;
      const hasData = hasSummDates.has(date);
      const clsArr = [];
      if (date === today) clsArr.push('today-col');
      else if (isPast && !hasData) clsArr.push('c-miss');
      else if (hasData) clsArr.push('c-has');
      if (dw === 6) clsArr.push('c-sat');
      if (dw === 0) clsArr.push('c-sun');
      const cls = clsArr.length ? ` class="${clsArr.join(' ')}"` : '';
      return `<th${cls} title="${isPast && !hasData ? 'Нет данных' : date}"><span class="th-dow">${dow}</span><br>${String(d).padStart(2,'0')}</th>`;
    }).join('');
    const colgroup = `<colgroup>
      <col style="width:148px"><col style="width:86px"><col style="width:80px">
      ${Array(WK).fill('<col style="width:68px">').join('')}
      <col style="width:78px">
      ${Array(daysInMonth).fill('<col style="width:36px">').join('')}
    </colgroup>`;
    const thead = `<thead><tr class="th-row">
      <th class="c-name" style="text-align:left">Показатель</th>
      <th class="c-spark">Тренд</th>
      <th class="c-avg">СР.Знач</th>
      ${wkThs}
      <th class="c-tot">ИТОГО</th>
      ${dayThs}
    </tr></thead>`;

    const rows = [];
    let _currentSection = '';
    let _rowIdx = 0;
    const H = (db.settings || {}).hidden || {};

    function secRowS(label, secCls) {
      _currentSection = secCls || '';
      _rowIdx = 0;
      if (H[secCls]) return;
      rows.push(`<tr class="sec-sep ${secCls||''}"><td colspan="${totalCols}">${label}</td></tr>`);
    }

    function mkSparkS(dayVals, up=true) {
      const vals = dayVals.map(v => isFinite(v)?v:0);
      const lastNonZero = vals.slice().reverse().findIndex(v=>v>0);
      const sliced = lastNonZero >= 0 ? vals.slice(0, vals.length - lastNonZero) : vals;
      if (sliced.every(v=>v===0)) return '';
      const color = up
        ? (sliced[sliced.length-1] >= sliced.find(v=>v>0) ? '#1e8e3e' : '#d93025')
        : (sliced[sliced.length-1] <= sliced.find(v=>v>0) ? '#1e8e3e' : '#d93025');
      return sparkline(sliced, 84, 22, color);
    }

    function rowS(label, avg_, wkVals, tot, dayVals, fmtFn, {cls} = {}) {
      if (H[_currentSection]) return;
      const wkCells = Array.from({length:WK}, (_,i) => {
        const v = wkVals[i];
        const s = (v != null && v !== 0 && isFinite(v)) ? fmtFn(v) : '<span class="z">—</span>';
        return `<td class="c-wk">${s}</td>`;
      }).join('');
      const dayCells = dayVals.map((v, di) => {
        const s = (v && isFinite(v) && v !== 0) ? fmtFn(v) : '<span class="z">—</span>';
        const date = `${ym}-${String(di+1).padStart(2,'0')}`;
        const dw = dayDow[di];
        const tclsArr = [];
        if (date === today) tclsArr.push('today-col');
        if (dw === 6) tclsArr.push('c-sat');
        if (dw === 0) tclsArr.push('c-sun');
        const tcls = tclsArr.length ? ` class="${tclsArr.join(' ')}"` : '';
        return `<td${tcls}>${s}</td>`;
      }).join('');
      const avgS = (avg_ != null && isFinite(avg_) && avg_ !== 0) ? fmtFn(avg_) : '';
      const totS = (tot  != null && isFinite(tot)  && tot  !== 0) ? fmtFn(tot)  : '';
      const spark = mkSparkS(dayVals);
      const secR = _currentSection ? _currentSection.replace('sep-','r-') : '';
      const evenOdd = (_rowIdx++ % 2 === 0) ? 'r-even' : 'r-odd';
      const allCls = [secR, evenOdd, cls].filter(Boolean).join(' ');
      const trCls = allCls ? ` class="${allCls}"` : '';
      rows.push(`<tr${trCls}>
        <td class="c-name">${label}</td>
        <td class="c-spark">${spark}</td>
        <td class="c-avg">${avgS}</td>
        ${wkCells}
        <td class="c-tot">${totS}</td>
        ${dayCells}
      </tr>`);
    }

    // -- SECTION: ЗАКАЗЫ --
    secRowS('▸ ЗАКАЗЫ [все товары]', 'sep-orders');
    rowS('ЗАКАЗЫ, шт', avgFAll.ordQ, wkFAll.map(f=>f.ordQ), fTotAll.ordQ, dayFAll.map(f=>f.ordQ), fmt);
    rowS('СПП %', avgFAll.spp, wkFAll.map(f=>f.spp), fTotAll.spp, dayFAll.map(f=>f.spp), v=>fmtP(v,2));
    rowS('Продажи (выкупы), шт', avgFAll.buyQ, wkFAll.map(f=>f.buyQ), fTotAll.buyQ, dayFAll.map(f=>f.buyQ), fmt);
    rowS('СР. Чек ₽', avgEAllDay.avgCheck, wkFAll.map(f=>f.ordQ>0?f.ordS/f.ordQ:0), fTotAll.ordQ>0?fTotAll.ordS/fTotAll.ordQ:0, dayFAll.map(f=>f.ordQ>0?f.ordS/f.ordQ:0), v=>fmt(v,0));
    rowS('Раздачи, шт', avgFAll.giveaway, wkFAll.map(f=>f.giveaway), fTotAll.giveaway, dayFAll.map(f=>f.giveaway), fmt);
    rowS('Сумма Заказов ₽', avgFAll.ordS, wkFAll.map(f=>f.ordS), fTotAll.ordS, dayFAll.map(f=>f.ordS), fmt);
    rowS('Сумма Продаж ₽', avgFAll.buyS, wkFAll.map(f=>f.buyS), fTotAll.buyS, dayFAll.map(f=>f.buyS), fmt);

    // -- SECTION: ВОРОНКА --
    secRowS('▸ ПОКАЗАТЕЛИ ВОРОНКИ ОБЩАЯ [все товары]', 'sep-funnel');
    rowS('Показы', avgFAll.shows, wkFAll.map(f=>f.shows), fTotAll.shows, dayFAll.map(f=>f.shows), fmt);
    rowS('Клики', avgFAll.clicks, wkFAll.map(f=>f.clicks), fTotAll.clicks, dayFAll.map(f=>f.clicks), fmt);
    rowS('% органики кликов', null, wkFAll.map(f=>f.clicks>0?(f.clicks-f.adsClicks)/f.clicks*100:null),
      fTotAll.clicks>0?(fTotAll.clicks-fTotAll.adsClicks)/fTotAll.clicks*100:null,
      dayFAll.map(f=>f.clicks>0?(f.clicks-f.adsClicks)/f.clicks*100:null), v=>fmtP(v,1));
    rowS('CTR %', avgEAllDay.ctr, wkEAll.map(e=>e.ctr), eTotAll.ctr, dayEAll.map(e=>e.ctr), v=>fmtP(v,2));
    rowS('Корзина, шт', avgFAll.cart, wkFAll.map(f=>f.cart), fTotAll.cart, dayFAll.map(f=>f.cart), fmt);
    rowS('Корзина %', avgEAllDay.cartPct, wkFAll.map(f=>f.clicks>0?f.cart/f.clicks*100:0),
      fTotAll.clicks>0?fTotAll.cart/fTotAll.clicks*100:0,
      dayFAll.map(f=>f.clicks>0?f.cart/f.clicks*100:0), v=>fmtP(v,2));

    // -- SECTION: ВОРОНКА РК --
    secRowS('▸ ПОКАЗАТЕЛИ ВОРОНКИ РЕКЛАМЫ [все товары]', 'sep-ads-funnel');
    rowS('Показы с РК', avgFAll.adsShows, wkFAll.map(f=>f.adsShows), fTotAll.adsShows, dayFAll.map(f=>f.adsShows), fmt);
    rowS('Клики РК', avgFAll.adsClicks, wkFAll.map(f=>f.adsClicks), fTotAll.adsClicks, dayFAll.map(f=>f.adsClicks), fmt);
    rowS('CTR % РК', avgEAllDay.ctrRk, wkFAll.map(f=>f.adsShows>0?f.adsClicks/f.adsShows*100:0),
      fTotAll.adsShows>0?fTotAll.adsClicks/fTotAll.adsShows*100:0,
      dayFAll.map(f=>f.adsShows>0?f.adsClicks/f.adsShows*100:0), v=>fmtP(v,2));
    rowS('CRO РК %', avgEAllDay.croRk, wkFAll.map(f=>f.adsClicks>0?f.buyQ/f.adsClicks*100:0),
      fTotAll.adsClicks>0?fTotAll.buyQ/fTotAll.adsClicks*100:0,
      dayFAll.map(f=>f.adsClicks>0?f.buyQ/f.adsClicks*100:0), v=>fmtP(v,2));
    rowS('Стоимость клика ₽', avgEAllDay.cpc, wkFAll.map(f=>f.adsClicks>0?f.adsSpend/f.adsClicks:0),
      fTotAll.adsClicks>0?fTotAll.adsSpend/fTotAll.adsClicks:0,
      dayFAll.map(f=>f.adsClicks>0?f.adsSpend/f.adsClicks:0), v=>fmt(v,1));

    // -- SECTION: ДРР --
    secRowS('▸ ДОЛЯ РЕКЛАМНЫХ РАСХОДОВ [все товары]', 'sep-ads');
    rowS('Расход РК ₽', avgFAll.adsSpend, wkFAll.map(f=>f.adsSpend), fTotAll.adsSpend, dayFAll.map(f=>f.adsSpend), fmt);
    rowS('ДРР %', eTotAll.drr, wkEAll.map(e=>e.drr), eTotAll.drr, dayEAll.map(e=>e.drr), v=>fmtP(v,1));

    // -- SECTION: ФИН --
    secRowS('▸ ФИН. ПОКАЗАТЕЛИ [все товары]', 'sep-fin');
    rowS('Продаж, шт', avgFAll.buyQ, wkFAll.map(f=>f.buyQ), fTotAll.buyQ, dayFAll.map(f=>f.buyQ), fmt);
    rowS('Сумма продаж ₽', avgFAll.buyS, wkFAll.map(f=>f.buyS), fTotAll.buyS, dayFAll.map(f=>f.buyS), fmt);
    rowS('Выкуп %', eTotAll.buyoutPct, wkEAll.map(e=>e.buyoutPct), eTotAll.buyoutPct, dayEAll.map(e=>e.buyoutPct), v=>fmtP(v,1));
    rowS('К перечислению ₽', eTotAll.kPerech/cntAll, wkEAll.map(e=>e.kPerech), eTotAll.kPerech, dayEAll.map(e=>e.kPerech), v=>fmt(v,0));
    rowS('Прибыль ₽', eTotAll.profit/cntAll, wkEAll.map(e=>e.profit), eTotAll.profit, dayEAll.map(e=>e.profit), v=>fmt(v,0));
    rowS('Маржа %', eTotAll.margin, wkEAll.map(e=>e.margin), eTotAll.margin, dayEAll.map(e=>e.margin), v=>fmtP(v,1));
    rowS('Возвраты, шт', avgFAll.returnQ, wkFAll.map(f=>f.returnQ), fTotAll.returnQ, dayFAll.map(f=>f.returnQ), fmt);
    rowS('Возврат %', eTotAll.returnPct, wkEAll.map(e=>e.returnPct), eTotAll.returnPct, dayEAll.map(e=>e.returnPct), v=>fmtP(v,1));
    rowS('Хранение ₽', avgFAll.storageCost, wkFAll.map(f=>f.storageCost), fTotAll.storageCost, dayFAll.map(f=>f.storageCost), fmt);
    rowS('Хранение %', eTotAll.storePct, wkEAll.map(e=>e.storePct), eTotAll.storePct, dayEAll.map(e=>e.storePct), v=>fmtP(v,1));
    rowS('Остаток (сумма), шт', null, wkFAll.map(f=>f.stock), fTotAll.stock, dayFAll.map(f=>f.stock), fmt);

    const table = `<div class="pg-wrap">
      <table class="pg">${colgroup}${thead}<tbody>${rows.join('')}</tbody></table>
    </div>`;

    return `<div class="prod-block prod-block-summary">${header}${table}</div>`;
  }

  function buildProdBlock(p, ym, weeks, daysInMonth, monthDays, monthDates, planM, tax, usd) {
    const [y, m] = ym.split('-').map(Number);
    const fTot = factOf(monthDays, p.sku, null);
    const eTot = econOf(fTot, p, tax);
    const plan = planM[p.sku] || {};

    // per-week
    const wkF = weeks.map(wDays => factOf(monthDays, p.sku, wDays.map(d=>`${ym}-${String(d).padStart(2,'0')}`)));
    const wkE = wkF.map(f => econOf(f, p, tax));

    // per-day
    const dayF = monthDates.map(date => factOf(monthDays, p.sku, [date]));
    const dayE = dayF.map(f => econOf(f, p, tax));

    // avg (per recorded day)
    const uniqDates = [...new Set(monthDays.filter(d=>d.sku===p.sku).map(d=>d.date))];
    const cnt = uniqDates.length || 1;
    const avgF = {
      ordQ:fTot.ordQ/cnt, ordS:fTot.ordS/cnt, buyQ:fTot.buyQ/cnt, buyS:fTot.buyS/cnt,
      shows:fTot.shows/cnt, clicks:fTot.clicks/cnt, cart:fTot.cart/cnt,
      adsShows:fTot.adsShows/cnt, adsClicks:fTot.adsClicks/cnt, adsSpend:fTot.adsSpend/cnt,
      spp:fTot.spp, giveaway:fTot.giveaway/cnt, stock:fTot.stock, n:1
    };
    const avgE = econOf(avgF, p, tax);

    const today = new Date().toISOString().slice(0,10);
    const dayNums = Array.from({length:daysInMonth}, (_,i)=>i+1);
    const WK = 5;
    const totalCols = 1 + 1 + 1 + WK + 1 + daysInMonth; // name+spark+avg+5wk+итог+days

    // -- HEADER BLOCK --
    const kPerechUsd = usd>0 ? eTot.kPerech/usd : 0;
    const stsC = { 'Локомотив':'loko','Рост':'rost','Аутсайдер':'outs','Новинка':'new' }[p.status] || 'none';
    const header = `<div class="ph">
      <table class="ph-t"><tbody>
        <tr>
          <td class="ph-name" rowspan="4">${esc(p.name||p.sku)}<br><span class="ph-sub">${p.wbId?'WB '+p.wbId:''}</span></td>
          <td class="ph-lbl">Рентаб. <span class="tip" data-tip="Рентабельность = Прибыль ÷ Себестоимость × 100. Показывает отдачу на вложения. Норма: >50%">?</span></td><td class="ph-val ${eTot.rentab>0?'g':'r'}">${fmtP(eTot.rentab)}</td>
          <td class="ph-lbl">К перечислению <span class="tip" data-tip="Сумма от WB = Выкупы − Комиссия − Логистика. До вычета себест. и налогов">?</span></td><td class="ph-val">${fmt(eTot.kPerech)} ₽</td>
          <td class="ph-lbl">ДРР % <span class="tip" data-tip="Доля рекламных расходов. Красный = превышен целевой ДРР товара">?</span></td><td class="ph-val ${eTot.drr>(p.planDrr||25)?'r':'g'}">${fmtP(eTot.drr)}</td>
          <td class="ph-lbl">Маржа % <span class="tip" data-tip="Чистая прибыльность = Прибыль ÷ Выкупы × 100. Норма: 15-35%">?</span></td><td class="ph-val ${eTot.margin<0?'r':'g'}">${fmtP(eTot.margin)}</td>
          <td class="ph-lbl">Прибыль <span class="tip" data-tip="Прибыль = К перечислению − Себест − Упаковка − Налог − Реклама">?</span></td><td class="ph-val ${eTot.profit<0?'r':'g'}">${fmt(eTot.profit)} ₽</td>
          <td class="ph-lbl">CTR % <span class="tip" data-tip="Click-Through Rate = Клики ÷ Показы × 100. Норма WB: 2-5%">?</span></td><td class="ph-val">${fmtP(eTot.ctr,2)}</td>
        </tr>
        <tr>
          <td class="ph-lbl">В деньгах</td><td class="ph-val">${fmt(eTot.kPerech)} ₽</td>
          <td class="ph-lbl">Кликов <span class="tip" data-tip="Общее количество кликов по карточке за месяц (органика + реклама)">?</span></td><td class="ph-val">${fmt(fTot.clicks)}</td>
          <td class="ph-lbl">Выкуп % <span class="tip" data-tip="Выкупы ÷ Заказы × 100. Критически важно! Низкий выкуп = двойная логистика. Норма >70%">?</span></td><td class="ph-val">${fmtP(eTot.buyoutPct)}</td>
          <td class="ph-lbl">Цена <span class="tip" data-tip="Текущая цена продажи товара (до СПП скидки). Редактируй в Товарах и плане">?</span></td><td class="ph-val">${fmt(p.price||0)} ₽</td>
          <td class="ph-lbl">Остаток <span class="tip" data-tip="Остаток на складе WB. Ноль = нет в продаже = падение позиций в поиске">?</span></td><td class="ph-val">${fmt(fTot.stock)} шт</td>
          <td class="ph-lbl">Статус <span class="tip" data-tip="Статус товара: Локомотив — основной продавец, Рост — растущий, Аутсайдер — слабый, Новинка — новый">?</span></td><td><span class="sts ${stsC}">${esc(p.status||'НЕ ВЫБРАНО')}</span></td>
        </tr>
        <tr>
          <td class="ph-lbl">В долларах <span class="tip" data-tip="К перечислению в долларах по курсу из Настроек. Удобно для импортных товаров">?</span></td><td class="ph-val">${fmt(kPerechUsd,0)} $</td>
          <td class="ph-lbl">Лог. ед ₽ <span class="tip" data-tip="Стоимость логистики WB за единицу товара. Умножается на кол-во выкупов">?</span></td><td class="ph-val">${fmt(p.logistics||0)}</td>
          <td class="ph-lbl">CRO % <span class="tip" data-tip="Conversion Rate = Заказы ÷ Показы × 100. Общая эффективность карточки">?</span></td><td class="ph-val">${fmtP(eTot.cro,2)}</td>
          <td class="ph-lbl">Себест ₽ <span class="tip" data-tip="Себестоимость единицы товара без упаковки. Задаётся в Товарах и плане">?</span></td><td class="ph-val">${fmt(p.cost||0)}</td>
          <td class="ph-lbl">Комис % <span class="tip" data-tip="Комиссия WB в процентах от цены продажи. Зависит от категории и FBO/FBS">?</span></td><td class="ph-val">${fmt(p.commission||0)}%</td>
          <td class="ph-lbl">Пр.Себес <span class="tip" data-tip="Суммарная себестоимость всех выкупленных единиц = Себест × кол-во выкупов">?</span></td><td class="ph-val">${fmt((p.cost||0)*fTot.buyQ)}</td>
        </tr>
        <tr>
          <td colspan="2" class="ph-lbl">Ответственный: <b>${esc(p.manager||'—')}</b></td>
          <td colspan="2" class="ph-lbl">Цел.ДРР: <b>${fmt(p.planDrr||0)}%</b></td>
          <td colspan="2" class="ph-lbl">Арт. SKU: <b>${esc(p.sku)}</b></td>
          <td colspan="2" class="ph-lbl">Дней данных: <b>${cnt}</b></td>
          <td colspan="4"><button class="ph-btn" onclick="App.openDay('${esc(p.sku)}')">＋ День</button>&nbsp;<button class="ph-btn" onclick="App.editProduct('${p.id}')">✏️ Товар</button></td>
        </tr>
      </tbody></table>
    ${p.sizes && p.sizes.length ? `
    <div class="ph-sizes">
      <table class="ph-sz-t">
        <thead><tr>
          <th class="ph-sz-lbl">Размер</th>
          ${p.sizes.map(s => `<th>${esc(s.size)}</th>`).join('')}
          <th>Общий</th>
        </tr></thead>
        <tbody>
          <tr>
            <td class="ph-sz-lbl">На складах</td>
            ${p.sizes.map(s => `<td class="${s.stock < 10 ? 'r' : s.stock < 30 ? 'o' : 'g'}">${s.stock}</td>`).join('')}
            <td><b>${p.sizes.reduce((a,s) => a+s.stock, 0)}</b></td>
          </tr>
          <tr>
            <td class="ph-sz-lbl">В пути</td>
            ${p.sizes.map(s => `<td>${s.inTransit || 0}</td>`).join('')}
            <td><b>${p.sizes.reduce((a,s) => a+(s.inTransit||0), 0)}</b></td>
          </tr>
          <tr>
            <td class="ph-sz-lbl">Общий</td>
            ${p.sizes.map(s => `<td>${(s.stock||0)+(s.inTransit||0)}</td>`).join('')}
            <td><b>${p.sizes.reduce((a,s) => a+(s.stock||0)+(s.inTransit||0), 0)}</b></td>
          </tr>
        </tbody>
      </table>
    </div>` : ''}
    </div>`;

    // -- TABLE --
    // col headers
    const wkThs = Array.from({length:WK}, (_,i) => `<th class="c-wk">Нед. ${i+1} <span class="tip" data-tip="Итог за ${i+1}-ю неделю месяца">?</span></th>`).join('');
    const DOW = ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'];
    const dayDow = dayNums.map(d => new Date(y, m-1, d).getDay()); // 0=sun,6=sat
    const hasDayData = new Set(monthDays.filter(d=>d.sku===p.sku).map(d=>d.date));
    const dayThs = dayNums.map((d, i) => {
      const date = `${ym}-${String(d).padStart(2,'0')}`;
      const dw = dayDow[i];
      const dow = DOW[dw];
      const isPast = date < today;
      const hasData = hasDayData.has(date);
      const clsArr = [];
      if (date === today) clsArr.push('today-col');
      else if (isPast && !hasData) clsArr.push('c-miss');
      else if (hasData) clsArr.push('c-has');
      if (dw === 6) clsArr.push('c-sat');
      if (dw === 0) clsArr.push('c-sun');
      const cls = clsArr.length ? ` class="${clsArr.join(' ')}"` : '';
      const missTitle = isPast && !hasData ? 'Нет данных за этот день' : date;
      return `<th${cls} title="${missTitle}" onclick="App.openDayEdit('${p.sku}', '${date}')" style="cursor:pointer"><span class="th-dow">${dow}</span><br>${String(d).padStart(2,'0')}<span class="day-edit-btn">✎</span></th>`;
    }).join('');
    const colgroup = `<colgroup>
      <col style="width:148px"><col style="width:86px"><col style="width:80px">
      ${Array(WK).fill('<col style="width:68px">').join('')}
      <col style="width:78px">
      ${Array(daysInMonth).fill('<col style="width:36px">').join('')}
    </colgroup>`;

    const thead = `<thead><tr class="th-row">
      <th class="c-name" style="text-align:left">Показатель</th>
      <th class="c-spark">Тренд</th>
      <th class="c-avg">СР.Знач <span class="tip" data-tip="Среднее значение за дни с данными (не за все 30 дней)">?</span></th>
      ${wkThs}
      <th class="c-tot">ИТОГ <span class="tip" data-tip="Итог за весь выбранный месяц">?</span></th>
      ${dayThs}
    </tr></thead>`;

    // rows builder
    const rows = [];
    let _currentSection = '';
    let _rowIdx = 0; // for alternating tint within section

    const H = (db.settings || {}).hidden || {};
    function secRow(label, secCls) {
      _currentSection = secCls || '';
      _rowIdx = 0;
      if (H[secCls]) return;
      rows.push(`<tr class="sec-sep ${secCls||''}"><td colspan="${totalCols}">${label}</td></tr>`);
    }

    // sparkline for a metric using daily values
    function mkSpark(dayVals, up=true) {
      const vals = dayVals.map(v => isFinite(v)?v:0);
      const lastNonZero = vals.slice().reverse().findIndex(v=>v>0);
      const sliced = lastNonZero >= 0 ? vals.slice(0, vals.length - lastNonZero) : vals;
      if (sliced.every(v=>v===0)) return '';
      const color = up
        ? (sliced[sliced.length-1] >= sliced.find(v=>v>0) ? '#1e8e3e' : '#d93025')
        : (sliced[sliced.length-1] <= sliced.find(v=>v>0) ? '#1e8e3e' : '#d93025');
      return sparkline(sliced, 84, 22, color);
    }

    function row(label, avg_, wkVals, tot, dayVals, fmtFn, {planVal, cls, rk} = {}) {
      if (H[_currentSection]) return;
      if (rk && H[rk]) return;
      const wkCells = Array.from({length:WK}, (_,i) => {
        const v = wkVals[i];
        const s = (v != null && v !== 0 && isFinite(v)) ? fmtFn(v) : '<span class="z">—</span>';
        return `<td class="c-wk">${s}</td>`;
      }).join('');
      const dayCells = dayVals.map((v, di) => {
        const s = (v && isFinite(v) && v !== 0) ? fmtFn(v) : '<span class="z">—</span>';
        const date = `${ym}-${String(di+1).padStart(2,'0')}`;
        const dw = dayDow[di];
        const tclsArr = [];
        if (date === today) tclsArr.push('today-col');
        if (dw === 6) tclsArr.push('c-sat');
        if (dw === 0) tclsArr.push('c-sun');
        const tcls = tclsArr.length ? ` class="${tclsArr.join(' ')}"` : '';
        return `<td${tcls}>${s}</td>`;
      }).join('');
      const avgS = (avg_ != null && isFinite(avg_) && avg_ !== 0) ? fmtFn(avg_) : '';
      const totS = (tot  != null && isFinite(tot)  && tot  !== 0) ? fmtFn(tot)  : '';
      const spark = mkSpark(dayVals);
      const secR = _currentSection ? _currentSection.replace('sep-','r-') : '';
      const evenOdd = (_rowIdx++ % 2 === 0) ? 'r-even' : 'r-odd';
      const allCls = [secR, evenOdd, cls].filter(Boolean).join(' ');
      const trCls = allCls ? ` class="${allCls}"` : '';
      rows.push(`<tr${trCls}>
        <td class="c-name">${label}</td>
        <td class="c-spark">${spark}</td>
        <td class="c-avg">${avgS}</td>
        ${wkCells}
        <td class="c-tot">${totS}</td>
        ${dayCells}
      </tr>`);
      if (planVal) {
        const exec = planVal>0 ? (tot||0)/planVal*100 : 0;
        const ec = exec>=100?'g':exec>=70?'oran':'r';
        const planSecCls = secR ? `plan-row ${secR}` : 'plan-row';
        rows.push(`<tr class="${planSecCls}">
          <td class="c-name">план</td>
          <td class="c-spark"></td>
          <td class="c-avg">${fmtFn(planVal)}</td>
          ${Array.from({length:WK},()=>'<td class="c-wk"></td>').join('')}
          <td class="c-tot"><span class="${ec}">${fmtP(exec)}</span></td>
          ${Array(daysInMonth).fill('<td></td>').join('')}
        </tr>`);
      }
    }

    // -- SECTION: ЗАКАЗЫ --
    secRow('▸ ЗАКАЗЫ', 'sep-orders');
    row('ЗАКАЗЫ, шт <span class="tip" data-tip="Количество заказов покупателей за период. Заказ ≠ выкуп — покупатель мог вернуть товар.">?</span>', avgF.ordQ, wkF.map(f=>f.ordQ), fTot.ordQ, dayF.map(f=>f.ordQ), fmt,
      {planVal: plan.ordQty});
    row('СПП % <span class="tip" data-tip="Скидка постоянного покупателя (%). Высокий СПП снижает реальную прибыль. Следи за маржой при СПП>30%.">?</span>', avgF.spp, wkF.map(f=>f.spp), fTot.spp, dayF.map(f=>f.spp), v=>fmtP(v,2), {rk:'spp'});
    row('Продажи (выкупы), шт <span class="tip" data-tip="Фактически выкупленные товары. По выкупам WB начисляет деньги. Норма выкупа от плана: >75%.">?</span>', avgF.buyQ, wkF.map(f=>f.buyQ), fTot.buyQ, dayF.map(f=>f.buyQ), fmt,
      {planVal: plan.buyQty});
    row('СР. Чек ₽ <span class="tip" data-tip="Средняя сумма одного заказа = Сумма заказов ÷ Кол-во заказов. Снижение = влияние акций или СПП.">?</span>', avgE.avgCheck, wkE.map(e=>e.avgCheck), eTot.avgCheck, dayE.map(e=>e.avgCheck), v=>fmt(v,0));
    row('Раздачи, шт <span class="tip" data-tip="Товары переданные блогерам/инфлюенсерам. Учитываются отдельно от продаж.">?</span>', avgF.giveaway, wkF.map(f=>f.giveaway), fTot.giveaway, dayF.map(f=>f.giveaway), fmt, {rk:'giveaway'});
    row('Выпол. плана ЗАКАЗЫ % <span class="tip" data-tip="Факт ÷ план × 100%. Зелёный ≥100%, оранжевый 70-99%, красный <70%.">?</span>', null, wkF.map((f,i)=>{
      const planWk = plan.ordQty ? plan.ordQty/weeks.length : 0;
      return planWk>0 ? f.ordQ/planWk*100 : null;
    }), plan.ordQty>0 ? fTot.ordQ/plan.ordQty*100 : null, Array(daysInMonth).fill(null), v=>fmtP(v), {cls:'plan-row', rk:'plan-ord'});
    row('Выпол. плана ПРОДАЖИ % <span class="tip" data-tip="Выкупы факт ÷ план выкупов × 100%. Часто отстаёт т.к. выкуп идёт с задержкой 5-14 дней.">?</span>', null, wkF.map((f,i)=>{
      const planWk = plan.buyQty ? plan.buyQty/weeks.length : 0;
      return planWk>0 ? f.buyQ/planWk*100 : null;
    }), plan.buyQty>0 ? fTot.buyQ/plan.buyQty*100 : null, Array(daysInMonth).fill(null), v=>fmtP(v), {cls:'plan-row', rk:'plan-buy'});
    row('Сумма Заказов ₽ <span class="tip" data-tip="Общая сумма заказов в рублях. Не равна сумме перечисления — из неё WB вычтет комиссию и логистику.">?</span>', avgF.ordS, wkF.map(f=>f.ordS), fTot.ordS, dayF.map(f=>f.ordS), fmt,
      {planVal: plan.ordRub});
    row('Сумма Продаж ₽ <span class="tip" data-tip="Сумма фактических выкупов в рублях. База для расчёта ДРР и перечисления.">?</span>', avgF.buyS, wkF.map(f=>f.buyS), fTot.buyS, dayF.map(f=>f.buyS), fmt);

    // -- SECTION: ВОРОНКА ОБЩАЯ --
    secRow('▸ ПОКАЗАТЕЛИ ВОРОНКИ ОБЩАЯ', 'sep-funnel');
    row('Показы <span class="tip" data-tip="Количество показов карточки в поиске/каталоге WB. Рост показов = лучшая видимость.">?</span>', avgF.shows, wkF.map(f=>f.shows), fTot.shows, dayF.map(f=>f.shows), fmt);
    row('Клики <span class="tip" data-tip="Клики покупателей по карточке товара (органические). CTR = Клики ÷ Показы.">?</span>', avgF.clicks, wkF.map(f=>f.clicks), fTot.clicks, dayF.map(f=>f.clicks), fmt);
    row('% органики кликов <span class="tip" data-tip="Доля кликов без рекламы = (Клики − Клики РК) ÷ Клики × 100. Высокий % = сильная органика.">?</span>', null, wkF.map(f=>{
      // organic = total clicks - rk clicks
      const org = f.clicks - f.adsClicks;
      return f.clicks>0 ? org/f.clicks*100 : null;
    }), fTot.clicks>0?(fTot.clicks-fTot.adsClicks)/fTot.clicks*100:null,
    dayF.map(f=>f.clicks>0?(f.clicks-f.adsClicks)/f.clicks*100:null), v=>fmtP(v,1));
    row('CTR % <span class="tip" data-tip="Click-Through Rate = Клики ÷ Показы × 100. Норма WB: 2-5%. Ниже 1% — меняй главное фото.">?</span>', avgE.ctr, wkE.map(e=>e.ctr), eTot.ctr, dayE.map(e=>e.ctr), v=>fmtP(v,2));
    row('Корзина, шт <span class="tip" data-tip="Добавлений в корзину. Промежуточный шаг воронки между кликом и заказом.">?</span>', avgF.cart, wkF.map(f=>f.cart), fTot.cart, dayF.map(f=>f.cart), fmt);
    row('Корзина % <span class="tip" data-tip="Конверсия клик→корзина = Корзина ÷ Клики × 100. Норма: 5-15%. Низко = проблема с ценой или описанием.">?</span>', avgE.cartPct, wkE.map(e=>e.cartPct), eTot.cartPct, dayE.map(e=>e.cartPct), v=>fmtP(v,2));
    row('Заказы % <span class="tip" data-tip="Конверсия клик→заказ = Заказы ÷ Клики × 100. Итоговая конверсия карточки. Норма: 2-8%.">?</span>', avgE.ordPct, wkE.map(e=>e.ordPct), eTot.ordPct, dayE.map(e=>e.ordPct), v=>fmtP(v,2));
    row('CRO % <span class="tip" data-tip="Conversion Rate = Заказы ÷ Показы × 100. Сводная метрика от показа до заказа.">?</span>', avgE.cro, wkE.map(e=>e.cro), eTot.cro, dayE.map(e=>e.cro), v=>fmtP(v,2));

    // -- SECTION: ВОРОНКА РК --
    secRow('▸ ПОКАЗАТЕЛИ ВОРОНКИ РЕКЛАМЫ', 'sep-ads-funnel');
    row('Показы с РК <span class="tip" data-tip="Показы через платную рекламу WB. Сравнивай с органическими показами.">?</span>', avgF.adsShows, wkF.map(f=>f.adsShows), fTot.adsShows, dayF.map(f=>f.adsShows), fmt);
    row('Клики РК <span class="tip" data-tip="Клики с рекламных кампаний WB. Платный трафик.">?</span>', avgF.adsClicks, wkF.map(f=>f.adsClicks), fTot.adsClicks, dayF.map(f=>f.adsClicks), fmt);
    row('CTR % РК <span class="tip" data-tip="CTR рекламы = Клики РК ÷ Показы РК × 100. Норма для WB рекламы: 0.3-1.5%.">?</span>', avgE.ctrRk, wkE.map(e=>e.ctrRk), eTot.ctrRk, dayE.map(e=>e.ctrRk), v=>fmtP(v,2));
    row('CRO РК % <span class="tip" data-tip="Конверсия рекламного трафика в заказы. Если ниже органического CRO — реклама менее целевая.">?</span>', avgE.croRk, wkE.map(e=>e.croRk), eTot.croRk, dayE.map(e=>e.croRk), v=>fmtP(v,2));
    row('Стоимость клика ₽ <span class="tip" data-tip="CPC = Расход РК ÷ Клики РК. Должен быть меньше Прибыль_с_заказа × Конверсия.">?</span>', avgE.cpc, wkE.map(e=>e.cpc), eTot.cpc, dayE.map(e=>e.cpc), v=>fmt(v,1));

    // -- SECTION: ДОЛЯ РК РАСХОДОВ --
    secRow('▸ ДОЛЯ РЕКЛАМНЫХ РАСХОДОВ', 'sep-ads');
    row('Расход РК ₽ <span class="tip" data-tip="Дневные расходы на рекламные кампании. Основа для расчёта ДРР.">?</span>', avgF.adsSpend, wkF.map(f=>f.adsSpend), fTot.adsSpend, dayF.map(f=>f.adsSpend), fmt);
    row('ДРР % <span class="tip" data-tip="Доля рекламных расходов = Расход ÷ Выкупы × 100. Целевой ДРР задаётся в настройках товара. Норма: 10-25%.">?</span>', avgE.drr, wkE.map(e=>e.drr), eTot.drr, dayE.map(e=>e.drr), v=>fmtP(v,1),
      {planVal: p.planDrr||null});

    // -- SECTION: ФИН. ПОКАЗАТЕЛИ --
    secRow('▸ ФИН. ПОКАЗАТЕЛИ', 'sep-fin');
    row('Продаж, шт <span class="tip" data-tip="Выкупы за период — основа для расчёта всех финансовых показателей.">?</span>', avgF.buyQ, wkF.map(f=>f.buyQ), fTot.buyQ, dayF.map(f=>f.buyQ), fmt);
    row('Сумма продаж ₽ <span class="tip" data-tip="Сумма выкупов в рублях = доход от покупателей до вычетов WB.">?</span>', avgF.buyS, wkF.map(f=>f.buyS), fTot.buyS, dayF.map(f=>f.buyS), fmt);
    row('Выкуп % <span class="tip" data-tip="Выкупы ÷ Заказы × 100. КРИТИЧЕСКИ ВАЖНО: низкий выкуп = платишь двойную логистику. Норма: >70%.">?</span>', avgE.buyoutPct, wkE.map(e=>e.buyoutPct), eTot.buyoutPct, dayE.map(e=>e.buyoutPct), v=>fmtP(v,1));
    row('К перечислению ₽ <span class="tip" data-tip="Сумма которую WB переведёт = Выкупы − Комиссия WB − Логистика × кол-во. До вычета себест. и налогов.">?</span>', avgE.kPerech, wkE.map(e=>e.kPerech), eTot.kPerech, dayE.map(e=>e.kPerech), v=>fmt(v,0));
    row('К перечислению на ед ₽ <span class="tip" data-tip="К перечислению ÷ кол-во выкупов. Доход с одной единицы товара до вычета себест.">?</span>', avgE.kPerechPer, wkE.map(e=>e.kPerechPer), eTot.kPerechPer, dayE.map(e=>e.kPerechPer), v=>fmt(v,0));
    row('Прибыль ₽ <span class="tip" data-tip="Чистая прибыль = К перечислению − Себест − Упаковка − Налог − Реклама. Главная метрика.">?</span>', avgE.profit, wkE.map(e=>e.profit), eTot.profit, dayE.map(e=>e.profit), v=>fmt(v,0));
    row('Прибыль на ед ₽ <span class="tip" data-tip="Прибыль ÷ кол-во выкупов. Чистый заработок с одной штуки.">?</span>', avgE.profitPer, wkE.map(e=>e.profitPer), eTot.profitPer, dayE.map(e=>e.profitPer), v=>fmt(v,0));
    row('Маржа % <span class="tip" data-tip="Прибыль ÷ Выкупы × 100. Норма для WB: 15-35%. Маржа < 0 = убыток.">?</span>', avgE.margin, wkE.map(e=>e.margin), eTot.margin, dayE.map(e=>e.margin), v=>fmtP(v,1));
    row('Рентабельность % <span class="tip" data-tip="Прибыль ÷ Себестоимость × 100. Отдача на вложенные деньги. Норма: >50%.">?</span>', avgE.rentab, wkE.map(e=>e.rentab), eTot.rentab, dayE.map(e=>e.rentab), v=>fmtP(v,1));
    row('Логистика % <span class="tip" data-tip="Расход на логистику ÷ Выкупы × 100. Показывает нагрузку логистики на выручку.">?</span>', avgE.logPct, wkE.map(e=>e.logPct), eTot.logPct, dayE.map(e=>e.logPct), v=>fmtP(v,1));
    row('Доля ВБ % (без ДРР) <span class="tip" data-tip="(Комиссия + Логистика) ÷ Выкупы × 100. Полная нагрузка WB без учёта рекламы.">?</span>', avgE.wbSharePct, wkE.map(e=>e.wbSharePct), eTot.wbSharePct, dayE.map(e=>e.wbSharePct), v=>fmtP(v,1));
    row('Доля ВБ с ДРР % <span class="tip" data-tip="(Комиссия + Логистика + Реклама) ÷ Выкупы × 100. Вся нагрузка на выручку.">?</span>', avgE.wbDrrPct, wkE.map(e=>e.wbDrrPct), eTot.wbDrrPct, dayE.map(e=>e.wbDrrPct), v=>fmtP(v,1));
    row('Возвраты, шт <span class="tip" data-tip="Количество возвращённых товаров. Высокий возврат увеличивает расходы на логистику.">?</span>', avgF.returnQ, wkF.map(f=>f.returnQ), fTot.returnQ, dayF.map(f=>f.returnQ), fmt);
    row('Возврат % <span class="tip" data-tip="Возвраты ÷ Выкупы × 100. Норма: < 10%. Высокий % — сигнал проблем с качеством или описанием.">?</span>', avgE.returnPct, wkE.map(e=>e.returnPct), eTot.returnPct, dayE.map(e=>e.returnPct), v=>fmtP(v,1));
    row('Хранение ₽ <span class="tip" data-tip="Стоимость хранения на складе WB за период. Вводится вручную или из отчёта WB.">?</span>', avgF.storageCost, wkF.map(f=>f.storageCost), fTot.storageCost, dayF.map(f=>f.storageCost), fmt);
    row('Хранение % <span class="tip" data-tip="Хранение ÷ Выкупы × 100. Показывает нагрузку хранения на выручку. Норма: < 3%.">?</span>', avgE.storePct, wkE.map(e=>e.storePct), eTot.storePct, dayE.map(e=>e.storePct), v=>fmtP(v,1));
    row('Остаток, шт <span class="tip" data-tip="Текущий остаток на складе WB. Обнуление = потеря позиций в поиске. Следи за пополнением.">?</span>', null, wkF.map(f=>f.stock), fTot.stock, dayF.map(f=>f.stock), fmt);

    const table = `<div class="pg-wrap">
      <table class="pg">${colgroup}${thead}<tbody>${rows.join('')}</tbody></table>
    </div>`;

    return `<div class="prod-block">${header}${table}</div>`;
  }

  // ---- Products tab ----
  function renderProducts() {
    const ym = curMonth();
    const [ymY, ymM] = ym.split('-');
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    $('prMonth').textContent = `${monthNames[+ymM]} ${ymY}`;
    const planM = db.plans[ym] || {};
    const monthDays = db.days.filter(d => d.date?.startsWith(ym));
    const tax = db.settings?.taxRate || 7;

    if (!db.products.length) {
      $('prEmpty').style.display = '';
      $('prRows').innerHTML = '';
    } else {
      $('prEmpty').style.display = 'none';
      $('prRows').innerHTML = db.products.map((p, idx) => `<tr>
        <td><button class="del-btn" onclick="App.delProduct('${p.id}')" title="Удалить">✕</button></td>
        <td><input value="${esc(p.name||p.sku)}" onchange="App.updProd('${p.id}','name',this.value)"></td>
        <td style="color:var(--muted);font-size:11px">${esc(p.sku)}</td>
        <td><input value="${esc(p.wbId||'')}" onchange="App.updProd('${p.id}','wbId',this.value)" placeholder="артикул WB"></td>
        <td class="num"><input type="number" value="${p.price||0}" min="0" onchange="App.updProd('${p.id}','price',+this.value)"></td>
        <td class="num"><input type="number" value="${p.cost||0}" min="0" onchange="App.updProd('${p.id}','cost',+this.value)"></td>
        <td class="num"><input type="number" value="${p.pkg||0}" min="0" onchange="App.updProd('${p.id}','pkg',+this.value)"></td>
        <td class="num"><input type="number" value="${p.logistics||0}" min="0" onchange="App.updProd('${p.id}','logistics',+this.value)"></td>
        <td class="num"><input type="number" value="${p.commission||0}" min="0" max="100" step=".5" onchange="App.updProd('${p.id}','commission',+this.value)"></td>
        <td class="num"><input type="number" value="${p.buyout||0}" min="0" max="100" onchange="App.updProd('${p.id}','buyout',+this.value)"></td>
        <td class="num"><input type="number" value="${p.planDrr||0}" min="0" max="100" onchange="App.updProd('${p.id}','planDrr',+this.value)"></td>
        <td><input value="${esc(p.manager||'')}" onchange="App.updProd('${p.id}','manager',this.value)" placeholder="имя"></td>
        <td><select onchange="App.updProd('${p.id}','status',this.value)">
          ${['НЕ ВЫБРАНО','Локомотив','Рост','Аутсайдер','Новинка'].map(s=>`<option${s===p.status?' selected':''}>${s}</option>`).join('')}
        </select></td>
      </tr>`).join('');
    }

    // Plan section with actual vs plan
    $('planRows').innerHTML = db.products.map(p => {
      const pl = planM[p.sku] || {};
      const f = factOf(monthDays, p.sku, null);
      const execOrdQ = pl.ordQty > 0 ? f.ordQ / pl.ordQty * 100 : null;
      const execOrdS = pl.ordRub > 0 ? f.ordS / pl.ordRub * 100 : null;
      const execBuyQ = pl.buyQty > 0 ? f.buyQ / pl.buyQty * 100 : null;
      const execCls = v => v == null ? '' : v >= 100 ? 'exec-g' : v >= 70 ? 'exec-o' : 'exec-r';
      const execStr = v => v == null ? '—' : `<span class="${execCls(v)}">${fmtP(v)}</span>`;
      return `<tr>
        <td><b>${esc(p.name||p.sku)}</b></td>
        <td class="num"><input type="number" value="${pl.ordQty||''}" min="0" placeholder="0"
          onchange="App.updPlan('${p.sku}','ordQty',+this.value);App.renderProducts()"></td>
        <td class="num"><input type="number" value="${pl.ordRub||''}" min="0" placeholder="0"
          onchange="App.updPlan('${p.sku}','ordRub',+this.value);App.renderProducts()"></td>
        <td class="num"><input type="number" value="${pl.buyQty||''}" min="0" placeholder="0"
          onchange="App.updPlan('${p.sku}','buyQty',+this.value);App.renderProducts()"></td>
        <td class="num ${f.ordQ>0?'':''}"><b>${fmt(f.ordQ)}</b></td>
        <td class="num"><b>${fmt(f.ordS)}</b></td>
        <td class="num">${execStr(execOrdQ)}</td>
        <td class="num"><b>${fmt(f.buyQ)}</b></td>
        <td class="num">${execStr(execBuyQ)}</td>
      </tr>`;
    }).join('');

    // Unit econ
    $('unitRows').innerHTML = db.products.map(p => {
      const price = p.price||0;
      const costFull = (p.cost||0)+(p.pkg||0);
      const comm = price*(p.commission||0)/100;
      const log = p.logistics||0;
      const kp = price-comm-log;
      const taxA = kp*tax/100;
      const profitPer = kp-costFull-taxA;
      const margin = price>0 ? profitPer/price*100 : 0;
      return `<tr>
        <td><b>${esc(p.name||p.sku)}</b></td>
        <td class="num">${fmt(price)}</td>
        <td class="num">${fmt(costFull)}</td>
        <td class="num">${fmt(kp,0)}</td>
        <td class="num ${profitPer<0?'r':'g'}">${fmt(profitPer,0)}</td>
        <td class="num ${margin<0?'r':'g'}">${fmtP(margin)}</td>
        <td class="num"><input type="number" id="tp_${p.id}" value="${price}" style="width:80px"
          onchange="App.calcTestPrice('${p.id}',+this.value,${costFull},${p.commission||0},${log},${tax})"></td>
        <td class="num" id="tpp_${p.id}">—</td>
        <td class="num" id="tpm_${p.id}">—</td>
      </tr>`;
    }).join('');
  }

  function calcTestPrice(id, tp, costFull, commPct, log, tax) {
    const comm=tp*commPct/100, kp=tp-comm-log, taxA=kp*tax/100, profit=kp-costFull-taxA, margin=tp>0?profit/tp*100:0;
    const ep=$('tpp_'+id), em=$('tpm_'+id);
    if(ep){ep.textContent=fmt(profit,0)+' ₽'; ep.className=profit<0?'r':'g';}
    if(em){em.textContent=fmtP(margin); em.className=margin<0?'r':'g';}
  }

  // ---- Visibility ----
  const VIS_ROWS = [
    { key:'sep-orders',    label:'🟢 Секция ЗАКАЗЫ',              type:'sec' },
    { key:'spp',           label:'СПП %',                         type:'row' },
    { key:'giveaway',      label:'Раздачи, шт',                   type:'row' },
    { key:'plan-ord',      label:'Выпол. плана ЗАКАЗЫ %',         type:'row' },
    { key:'plan-buy',      label:'Выпол. плана ПРОДАЖИ %',        type:'row' },
    { key:'sep-funnel',    label:'🔵 Секция ВОРОНКА ОБЩАЯ',       type:'sec' },
    { key:'sep-ads-funnel',label:'🔵 Секция ВОРОНКА РЕКЛАМЫ',     type:'sec' },
    { key:'sep-ads',       label:'🟠 Секция ДРР',                 type:'sec' },
    { key:'sep-fin',       label:'🔴 Секция ФИН. ПОКАЗАТЕЛИ',     type:'sec' },
  ];

  function renderVisibility() {
    const h = db.settings.hidden || {};
    $('visRows').innerHTML = VIS_ROWS.map(r => `
      <label class="vis-row${r.type==='sec'?' vis-sec':''}">
        <input type="checkbox" ${h[r.key]?'':'checked'} onchange="App.toggleHidden('${r.key}',!this.checked)">
        ${r.label}
      </label>`).join('');
  }

  function toggleHidden(key, hide) {
    if (!db.settings.hidden) db.settings.hidden = {};
    if (hide) db.settings.hidden[key] = true;
    else delete db.settings.hidden[key];
    save();
    renderVisibility();
    render();
  }

  // ---- Settings ----
  function renderSettings() {
    const s = db.settings||{};
    if($('apiKey'))  $('apiKey').value=s.apiKey||'';
    if($('taxRate')) $('taxRate').value=s.taxRate??7;
    if($('usdRate')) $('usdRate').value=s.usdRate??90;
    if($('shopName')) $('shopName').value=s.shopName||'';
    // Профиль
    const letter = ($('topAvatar')?.textContent||'?');
    [$('setAvatar')].forEach(el => { if(el) el.textContent = letter; });
    if($('setPdName'))  $('setPdName').textContent  = $('topPdName')?.textContent||'—';
    if($('setPdEmail')) $('setPdEmail').textContent = $('topPdEmail')?.textContent||'—';
    $('logBox').innerHTML=(db.log||[]).slice(0,50).map(l=>`<div>${(l.t||'').slice(0,19)} · ${esc(l.msg)}</div>`).join('');
    renderVisibility();
  }

  // ---- init ----
  async function init() {
    // Check auth
    let meUser = null;
    try {
      const me = await fetch('/api/auth/me').then(r => r.json());
      if (!me || !me.user) { window.location.href = '/login.html'; return; }
      meUser = me.user;
      const letter = (me.user.name || '?')[0].toUpperCase();
      // Аватар + имя в шапке
      [$('topAvatar'),$('topAvatarDrop')].forEach(el => { if(el) el.textContent = letter; });
      const ui = $('userInfo'); if(ui) ui.textContent = me.user.name;
      const pdName = $('topPdName'); if(pdName) pdName.textContent = me.user.name;
      const pdEmail = $('topPdEmail'); if(pdEmail) pdEmail.textContent = me.user.email || '';
    } catch { window.location.href = '/login.html'; return; }

    // Дождаться загрузки данных чтобы получить shopName из настроек
    await load();

    const shopName = db.settings?.shopName || meUser?.name || 'Мой магазин';
    const shopEl = $('topShopName'); if(shopEl) shopEl.textContent = shopName;

    _setMonth(new Date().toISOString().slice(0,7));
    document.querySelectorAll('.sheet-tab').forEach(t => t.addEventListener('click', () => {
      if (t.classList.contains('cat-tab')) return; // cat-tabs handled by filterByCategory
      document.querySelectorAll('.sheet-tab').forEach(x=>x.classList.remove('active'));
      document.querySelectorAll('.page').forEach(x=>x.classList.remove('active'));
      t.classList.add('active'); $('p-'+t.dataset.p).classList.add('active');
      if(t.dataset.p==='rnp') { activeCategory = null; render(); }
      if(t.dataset.p==='products') renderProducts();
      if(t.dataset.p==='settings') renderSettings();
    }));
    if(localStorage.getItem('theme')==='dark'){ document.body.classList.add('dark'); $('themeBtn').textContent='☀️'; }
    buildCategoryTabs();
    render();
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  }

  function downloadCostTemplate() {
    const header = 'SKU,Название,Себестоимость,Цена продажи,Комиссия %,Логистика ₽,Упаковка ₽,Цел. ДРР %';
    const rows = [header, ...db.products.map(p =>
      [p.sku, `"${(p.name||'').replace(/"/g,'""')}"`, p.cost||0, p.price||0, p.commission||15, p.logistics||0, p.pkg||0, p.planDrr||0].join(',')
    )];
    const blob = new Blob(['﻿'+rows.join('\n')], {type:'text/csv;charset=utf-8'});
    const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='себестоимость-шаблон.csv'; a.click();
  }

  function importCosts() { $('costFileInput').click(); }

  function handleCostFile(input) {
    const file = input.files[0]; if(!file) return;
    const reader = new FileReader();
    reader.onload = async e => {
      const lines = e.target.result.split(/\r?\n/).filter(l=>l.trim()&&!l.startsWith('#'));
      if(lines.length<2) return toast('Файл пустой или неверный формат');
      const hdr = lines[0].split(',').map(s=>s.trim().toLowerCase());
      const idx = k => hdr.findIndex(h=>h.includes(k));
      const iSku=idx('sku'); const iCost=idx('себес'); const iPrice=idx('цена'); const iComm=idx('комис'); const iLog=idx('логис'); const iPkg=idx('упако'); const iDrr=idx('дрр');
      if(iSku<0) return toast('Нет колонки SKU в файле');
      const rows=[];
      for(let i=1;i<lines.length;i++){
        const cols=lines[i].split(','); const get=j=>j>=0?(cols[j]||'').replace(/^"|"$/g,'').trim():'';
        const sku=get(iSku); if(!sku) continue;
        rows.push({sku, cost:get(iCost), price:get(iPrice), commission:get(iComm), logistics:get(iLog), pkg:get(iPkg), planDrr:get(iDrr)});
      }
      const r=await(await fetch('/api/import/costs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({rows})})).json();
      toast((r.ok?'✅ ':'❌ ')+r.msg);
      if(r.ok){await load();render();}
      input.value='';
    };
    reader.readAsText(file,'utf-8');
  }

  async function loadDemo() {
    if (!confirm('Загрузить демо-данные? Текущие данные будут удалены.')) return;
    const r = await fetch('/api/load-demo', { method: 'POST' });
    if (r.ok) { await load(); buildCategoryTabs(); render(); }
    else alert('Ошибка загрузки демо');
  }

  function render() { renderRnp(); }

  // ---- CRUD ----
  function addProduct() {
    ['apName','apSku','apWbId','apPrice','apCost','apPkg','apLog','apComm','apBuyout','apPlanDrr','apManager','apCategory']
      .forEach(id => { const el=$(id); if(el) el.value=''; });
    $('apComm').value = '15'; $('apBuyout').value = '70'; $('apPlanDrr').value = '15';
    if($('apStatus')) $('apStatus').value = '';
    if($('apSizesStock')) $('apSizesStock').value = '';
    if($('apSizesTransit')) $('apSizesTransit').value = '';
    delete $('apSku').dataset.editId; // ensure create mode
    $('mAddProd').classList.add('open');
  }
  function parseSizes(stockStr, transitStr) {
    const stockMap = {};
    const transitMap = {};
    if (stockStr) stockStr.split(',').forEach(s => {
      const [sz, n] = s.trim().split(':');
      if (sz && n) stockMap[sz.trim()] = parseInt(n)||0;
    });
    if (transitStr) transitStr.split(',').forEach(s => {
      const [sz, n] = s.trim().split(':');
      if (sz && n) transitMap[sz.trim()] = parseInt(n)||0;
    });
    const allSizes = [...new Set([...Object.keys(stockMap), ...Object.keys(transitMap)])];
    return allSizes.map(sz => ({ size:sz, stock:stockMap[sz]||0, inTransit:transitMap[sz]||0 }));
  }
  function saveNewProduct() {
    const sku = $('apSku').value.trim();
    const name = $('apName').value.trim();
    if (!sku) { toast('Укажи SKU'); return; }
    const editId = $('apSku').dataset.editId;
    if (editId) {
      // UPDATE mode
      const p = db.products.find(x => x.id === editId);
      if (p) {
        p.name = name || sku; p.sku = sku; p.wbId = $('apWbId').value.trim();
        p.price = +$('apPrice').value||0; p.cost = +$('apCost').value||0;
        p.pkg = +$('apPkg').value||0; p.logistics = +$('apLog').value||0;
        p.commission = +$('apComm').value||15; p.buyout = +$('apBuyout').value||70;
        p.planDrr = +$('apPlanDrr').value||0;
        p.manager = $('apManager').value.trim();
        p.status = $('apStatus') ? $('apStatus').value || 'НЕ ВЫБРАНО' : (p.status||'НЕ ВЫБРАНО');
        p.category = $('apCategory') ? $('apCategory').value.trim() : (p.category || '');
        p.sizes = parseSizes($('apSizesStock')?.value||'', $('apSizesTransit')?.value||'');
      }
      delete $('apSku').dataset.editId;
      save(); close('mAddProd'); renderProducts(); render(); toast('Товар обновлён ✓');
    } else {
      // CREATE mode
      db.products.push({
        id: uid(), sku, wbId: $('apWbId').value.trim(),
        name: name || sku,
        price: +$('apPrice').value||0, cost: +$('apCost').value||0,
        pkg: +$('apPkg').value||0, logistics: +$('apLog').value||0,
        commission: +$('apComm').value||15, buyout: +$('apBuyout').value||70,
        planDrr: +$('apPlanDrr').value||0,
        manager: $('apManager').value.trim(),
        status: $('apStatus') ? $('apStatus').value || 'НЕ ВЫБРАНО' : 'НЕ ВЫБРАНО',
        category: $('apCategory') ? $('apCategory').value.trim() : '',
        sizes: parseSizes($('apSizesStock')?.value||'', $('apSizesTransit')?.value||'')
      });
      save(); close('mAddProd'); renderProducts(); render(); toast('Товар добавлен ✓');
    }
  }
  function editProduct(id) {
    const p = db.products.find(x => x.id === id);
    if (!p) { toast('Товар не найден'); return; }
    $('apName').value = p.name || '';
    $('apSku').value = p.sku || '';
    $('apWbId').value = p.wbId || '';
    $('apPrice').value = p.price || 0;
    $('apCost').value = p.cost || 0;
    $('apPkg').value = p.pkg || 0;
    $('apLog').value = p.logistics || 0;
    $('apComm').value = p.commission ?? 15;
    $('apBuyout').value = p.buyout ?? 70;
    $('apPlanDrr').value = p.planDrr ?? 0;
    $('apManager').value = p.manager || '';
    if($('apStatus')) $('apStatus').value = p.status || '';
    if($('apCategory')) $('apCategory').value = p.category || '';
    if($('apSizesStock') && p.sizes) {
      $('apSizesStock').value = p.sizes.map(s => `${s.size}:${s.stock}`).join(', ');
      const transit = p.sizes.filter(s=>s.inTransit>0);
      if($('apSizesTransit')) $('apSizesTransit').value = transit.map(s => `${s.size}:${s.inTransit}`).join(', ');
    }
    $('apSku').dataset.editId = id; // store editing id
    $('mAddProd').classList.add('open');
  }
  function updProd(id, key, val) {
    const p=db.products.find(x=>x.id===id); if(p){p[key]=val; save();}
  }
  function updPlan(sku, key, val) {
    const ym=curMonth();
    if(!db.plans[ym])db.plans[ym]={};
    if(!db.plans[ym][sku])db.plans[ym][sku]={};
    db.plans[ym][sku][key]=val; save();
  }
  function delProduct(id) {
    if(!confirm('Удалить товар?'))return;
    db.products=db.products.filter(p=>p.id!==id); save(); renderProducts(); render(); toast('Удалено');
  }

  // ---- Day modal ----
  function openDay(sku) {
    $('dayTitle').textContent='Данные за день';
    $('dId').value='';
    $('dayDate').value=new Date().toISOString().slice(0,10);
    // populate daySku select
    const skuSel=$('daySku');
    skuSel.innerHTML='<option value="">— выбери товар —</option>'+db.products.map(p=>`<option value="${esc(p.sku)}">${esc(p.name||p.sku)}</option>`).join('');
    if(sku) skuSel.value=sku;
    ['dayStock','dayOrdQ','dayOrdS','dayBuyQ','dayBuyS','dayShows','dayClicks','dayCart','dayAdsShows','dayAdsClicks','dayAdsSpend','daySpp','dayGiveaway','dayReturnQ','dayStorageCost']
      .forEach(id=>{ const el=$(id); if(el)el.value=''; });
    $('skuList').innerHTML=db.products.map(p=>`<option value="${esc(p.sku)}">${esc(p.name||p.sku)}</option>`).join('');
    $('mDay').classList.add('open');
  }
  function openDayEdit(sku, date) {
    const existing = db.days.find(d => d.sku === sku && d.date === date);
    openDay(sku);
    setTimeout(() => {
      $('dayDate').value = date;
      $('daySku').value = sku;
      if (existing) {
        $('dId').value = existing.id || '';
        $('dayOrdQ').value = existing.ordQ || '';
        $('dayOrdS').value = existing.ordS || '';
        $('dayBuyQ').value = existing.buyQ || '';
        $('dayBuyS').value = existing.buyS || '';
        $('dayShows').value = existing.shows || '';
        $('dayClicks').value = existing.clicks || '';
        $('dayCart').value = existing.cart || '';
        $('dayStock').value = existing.stock || '';
        $('dayAdsShows').value = existing.adsShows || '';
        $('dayAdsClicks').value = existing.adsClicks || '';
        $('dayAdsSpend').value = existing.adsSpend || '';
        $('daySpp').value = existing.spp || '';
        $('dayGiveaway').value = existing.giveaway || '';
        $('dayReturnQ').value = existing.returnQ || '';
        $('dayStorageCost').value = existing.storageCost || '';
        $('dayTitle').textContent = `✏️ Редактировать: ${date}`;
      } else {
        $('dayTitle').textContent = `➕ Добавить данные: ${date}`;
      }
    }, 50);
  }
  function saveDay() {
    const rec = {
      id: $('dId').value || uid(),
      date:$('dayDate').value, sku:($('daySku').value||'').trim(),
      stock:+$('dayStock').value||0, ordQ:+$('dayOrdQ').value||0, ordS:+$('dayOrdS').value||0,
      buyQ:+$('dayBuyQ').value||0, buyS:+$('dayBuyS').value||0,
      shows:+$('dayShows').value||0, clicks:+$('dayClicks').value||0, cart:+$('dayCart').value||0,
      adsShows:+$('dayAdsShows').value||0, adsClicks:+$('dayAdsClicks').value||0, adsSpend:+$('dayAdsSpend').value||0,
      spp:+$('daySpp').value||0, giveaway:+$('dayGiveaway').value||0,
      returnQ:+$('dayReturnQ').value||0, storageCost:+$('dayStorageCost').value||0, source:'manual'
    };
    if(!rec.date||!rec.sku){toast('Укажи дату и SKU');return;}
    // Prefer matching by dId first, then by date+sku (any source)
    const byId = $('dId').value ? db.days.findIndex(d=>d.id===$('dId').value) : -1;
    const ex = byId >= 0 ? byId : db.days.findIndex(d=>d.date===rec.date&&d.sku===rec.sku);
    if(ex>=0) db.days[ex]={...db.days[ex],...rec}; else db.days.push(rec);
    save(); close('mDay'); render(); toast('Сохранено ✓');
  }
  function close(id){$(id).classList.remove('open');}

  // ---- Settings actions ----
  function saveSettings() {
    db.settings.apiKey=$('apiKey').value.trim();
    db.settings.taxRate=+$('taxRate').value||7;
    db.settings.usdRate=+$('usdRate').value||90;
    const shopName=$('shopName')?.value.trim();
    if(shopName!=null) db.settings.shopName=shopName;
    const shopEl=$('topShopName'); if(shopEl) shopEl.textContent=shopName||'Мой магазин';
    save(); toast('Сохранено ✅');
  }
  async function wbTest() {
    const key=$('apiKey').value.trim(); if(!key){$('wbMsg').textContent='⚠️ Введи API-ключ';return;}
    $('wbMsg').textContent='⏳ Проверяю...';
    try {
      const r=await(await fetch('/api/wb/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})})).json();
      $('wbMsg').textContent=(r.ok?'✅ ':'❌ ')+r.msg;
    } catch(e) { $('wbMsg').textContent='❌ Ошибка сети: '+e.message; }
  }
  async function wbImportCards() {
    const key=$('apiKey').value.trim(); if(!key){$('wbMsg').textContent='⚠️ Введи API-ключ';return;}
    $('wbMsg').textContent='⏳ Загружаю товары из WB...';
    try {
      const r=await(await fetch('/api/wb/cards',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key})})).json();
      $('wbMsg').textContent=(r.ok?'✅ ':'❌ ')+r.msg;
      if(r.ok){ await load(); buildCategoryTabs(); renderProducts(); }
    } catch(e) { $('wbMsg').textContent='❌ Ошибка: '+e.message; }
  }

  async function wbSync() {
    const key=$('apiKey').value.trim();
    const dateFrom=$('dateFrom').value||new Date(Date.now()-30*864e5).toISOString().slice(0,10);
    $('wbMsg').textContent='⏳ Загружаю...';
    try {
      const r=await(await fetch('/api/wb/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:key,dateFrom})})).json();
      $('wbMsg').textContent=(r.ok?'✅ ':'❌ ')+r.msg;
      if(r.ok){await load();render();}
    } catch(e) { $('wbMsg').textContent='❌ Ошибка сети: '+e.message; }
  }
  function theme() {
    document.body.classList.toggle('dark');
    const dark=document.body.classList.contains('dark');
    localStorage.setItem('theme',dark?'dark':'light');
    $('themeBtn').textContent=dark?'☀️':'🌙';
  }
  function toast(msg) {
    const t=$('toast');
    t.textContent = String(msg).slice(0, 120); // truncate to avoid layout break
    t.classList.add('show');
    setTimeout(()=>t.classList.remove('show'),2000);
  }

  // ---- Month navigation ----
  const MO_NAMES = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
  const MO_FULL  = ['Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
  let _mpYear = new Date().getFullYear();

  function _setMonth(ym) {
    $('month').value = ym;
    const [y,m] = ym.split('-').map(Number);
    $('monthLabel').textContent = `${MO_FULL[m-1]} ${y} г.`;
    render();
  }

  function shiftMonth(delta) {
    const [y, m] = (curMonth()).split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    if (d < new Date(2020, 0, 1)) return;
    _setMonth(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`);
  }

  function toggleMonthPicker(e) {
    e.stopPropagation();
    const p = $('monthPicker');
    if (p.style.display === 'none') {
      const [y] = curMonth().split('-').map(Number);
      _mpYear = y;
      _renderMpGrid();
      p.style.display = 'block';
      setTimeout(() => document.addEventListener('click', _mpClose, {once:true}), 0);
    } else {
      p.style.display = 'none';
    }
  }

  function _mpClose() { $('monthPicker').style.display = 'none'; }

  function mpShiftYear(d) {
    _mpYear += d;
    $('mpYear').textContent = _mpYear;
    _renderMpGrid();
  }

  function _renderMpGrid() {
    $('mpYear').textContent = _mpYear;
    const hasData = new Set((db.days||[]).map(d => d.date?.slice(0,7)));
    const cur = curMonth();
    $('mpGrid').innerHTML = MO_NAMES.map((name, i) => {
      const ym = `${_mpYear}-${String(i+1).padStart(2,'0')}`;
      const has = hasData.has(ym);
      const active = ym === cur;
      return `<button class="mp-mo${active?' mp-cur':''}${has?' mp-has':''}" onclick="App._pickMonth('${ym}')">${name}</button>`;
    }).join('');
  }

  function _pickMonth(ym) {
    $('monthPicker').style.display = 'none';
    _setMonth(ym);
  }

  // ---- Archive ----
  async function archiveMonth() {
    try {
    const ym = curMonth();
    const monthDays = db.days.filter(d => d.date?.startsWith(ym));
    const monthNames = ['','Январь','Февраль','Март','Апрель','Май','Июнь','Июль','Август','Сентябрь','Октябрь','Ноябрь','Декабрь'];
    const [y,m] = ym.split('-');
    const name = `${monthNames[+m]} ${y}`;
    const snapshot = {
      ym, name,
      savedAt: new Date().toISOString(),
      products: db.products,
      plans: { [ym]: db.plans[ym] || {} },
      days: monthDays,
      settings: db.settings
    };
    const r = await fetch('/api/archive/save', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(snapshot)
    });
    const j = await r.json();
    if (j.ok) toast(`✅ Архив ${name} сохранён`);
    else toast('Ошибка архивирования: ' + (j.msg||''));
    } catch(e) { toast('Ошибка архивирования: ' + e.message); }
  }

  // ---- CSV template & import ----
  const CSV_COLS = ['date','sku','ordQ','ordS','buyQ','buyS','stock','shows','clicks','cart','adsShows','adsClicks','adsSpend','spp','giveaway','returnQ','storageCost'];
  const CSV_LABELS = ['Дата (ГГГГ-ММ-ДД)','SKU товара','Заказы шт','Заказы руб','Продажи шт','Продажи руб','Остаток шт','Показы','Клики','Корзина шт','Показы РК','Клики РК','Расход РК руб','СПП %','Раздачи шт','Возвраты шт','Хранение руб'];

  function downloadTemplate() {
    const today = new Date().toISOString().slice(0,10);
    const rows = [
      '# РНП — Шаблон ежедневного отчёта. Заполни и загрузи через кнопку "Загрузить файл"',
      '# Обязательные колонки: Дата (ГГГГ-ММ-ДД) и SKU товара. Остальные — по наличию данных.',
      '# Показы/Клики/Корзина/Реклама — из раздела "Аналитика" в личном кабинете WB.',
      '# Хранение руб — из отчёта "Расчёт платного хранения" в WB (раздел Финансы).',
      CSV_LABELS.join(','),
    ];
    // Пример строки для каждого товара
    if (db.products.length) {
      db.products.forEach(p => {
        const price = p.price || 1000;
        const buyQ = 3; const ordQ = 4;
        rows.push([
          today, p.sku,
          ordQ, Math.round(ordQ * price * 0.9),
          buyQ, Math.round(buyQ * price * 0.88),
          100, 12000, 150, 40,
          5000, 60, 800, 13, 0, 0, Math.round(100 * 1.2)
        ].join(','));
      });
    } else {
      rows.push(`${today},Мой-SKU,4,3600,3,2700,100,12000,150,40,5000,60,800,13,0,0,120`);
    }
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `rnp-шаблон-${today}.csv`; a.click();
  }

  function exportData(mode) {
    // mode: 'month' = текущий месяц, 'all' = все данные
    const ym = $('month').value || new Date().toISOString().slice(0,7);
    const filtered = mode === 'month'
      ? db.days.filter(d => d.date && d.date.startsWith(ym))
      : db.days;
    if (!filtered.length) return toast('Нет данных для экспорта');
    const sorted = [...filtered].sort((a,b) => a.date < b.date ? -1 : 1);
    const rows = [CSV_LABELS.join(',')];
    for (const d of sorted) {
      rows.push([
        d.date, d.sku,
        d.ordQ||0, d.ordS||0,
        d.buyQ||0, d.buyS||0,
        d.stock||0, d.shows||0,
        d.clicks||0, d.cart||0,
        d.adsShows||0, d.adsClicks||0,
        d.adsSpend||0,
        (d.spp||0).toFixed(2),
        d.giveaway||0
      ].join(','));
    }
    const fname = mode === 'month' ? `rnp-данные-${ym}.csv` : 'rnp-все-данные.csv';
    const blob = new Blob(['﻿' + rows.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = fname; a.click();
    toast(`Экспорт: ${filtered.length} записей`);
  }

  function importCsv() { $('csvFileInput').click(); }

  function handleCsvFile(input) {
    const file = input.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      const lines = e.target.result.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
      if (lines.length < 2) return toast('CSV пустой или неверный формат');
      // определяем заголовок
      const header = lines[0].replace(/^﻿/, '').split(',').map(s => s.trim());
      // поддерживаем и английские ключи (date,sku,...) и русские метки из шаблона
      const idxOf = key => {
        const engIdx = header.findIndex(h => h.toLowerCase() === key.toLowerCase());
        if (engIdx >= 0) return engIdx;
        const ruLabel = CSV_LABELS[CSV_COLS.indexOf(key)];
        return ruLabel ? header.findIndex(h => h === ruLabel) : -1;
      };
      const idx = {};
      CSV_COLS.forEach(c => { idx[c] = idxOf(c); });
      if (idx.date < 0 || idx.sku < 0) return toast('Нет колонок date/sku в CSV');

      let added = 0, updated = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        const get = key => { const v = cols[idx[key]]; return v !== undefined ? v.trim() : ''; };
        const num = key => { const v = parseFloat(get(key).replace(',','.')); return isNaN(v) ? 0 : v; };
        const date = get('date'); const sku = get('sku');
        if (!date || !sku) continue;
        const id = 'imp' + date + sku;
        const rec = { id, date, sku, ordQ:num('ordQ'), ordS:num('ordS'), buyQ:num('buyQ'), buyS:num('buyS'), stock:num('stock'), shows:num('shows'), clicks:num('clicks'), cart:num('cart'), adsShows:num('adsShows'), adsClicks:num('adsClicks'), adsSpend:num('adsSpend'), spp:num('spp'), giveaway:num('giveaway'), returnQ:num('returnQ'), storageCost:num('storageCost'), source:'import' };
        const existing = db.days.findIndex(d => d.id === id);
        if (existing >= 0) { db.days[existing] = rec; updated++; } else { db.days.push(rec); added++; }
      }
      save().then(() => {
        render();
        toast(`✅ Импорт: +${added} новых, ${updated} обновлено`);
        close('mDay'); // закрываем модал дня если открыт
      }).catch(e => toast('Ошибка сохранения: ' + e.message));
      input.value = '';
    };
    reader.readAsText(file, 'utf-8');
  }

  function switchTo(tab) {
    const isAddProduct = tab === 'products';
    const targetTab = isAddProduct ? 'products' : tab;
    document.querySelectorAll('.sheet-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.p === targetTab);
    });
    document.querySelectorAll('.page').forEach(p => {
      p.classList.toggle('active', p.id === 'p-' + targetTab);
    });
    if (targetTab === 'products') renderProducts();
    if (targetTab === 'settings') renderSettings();
    if (targetTab === 'rnp') { activeCategory = null; render(); }
    if (isAddProduct) setTimeout(() => addProduct(), 50);
  }

  window.addEventListener('DOMContentLoaded', init);
  return {render,openDay,openDayEdit,saveDay,close,addProduct,saveNewProduct,editProduct,updProd,updPlan,delProduct,saveSettings,wbTest,wbSync,wbImportCards,theme,calcTestPrice,downloadTemplate,exportData,importCsv,handleCsvFile,downloadCostTemplate,importCosts,handleCostFile,shiftMonth,archiveMonth,toggleHidden,switchTo,logout,loadDemo,toggleMonthPicker,mpShiftYear,_pickMonth,buildCategoryTabs,filterByCategory};
})();

// Аккордеон инструкции (глобальные функции)
function hToggle(hd) {
  const card = hd.closest('.acc-card');
  card.classList.toggle('open');
}
function hScroll(a, id) {
  event.preventDefault();
  const el = document.getElementById(id);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.querySelectorAll('.h-nav-a').forEach(x => x.classList.remove('active'));
  a.classList.add('active');
}
