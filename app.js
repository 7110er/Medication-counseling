/* 疾病全人照護平台 v2.4 前端（GitHub Pages）
 * 定位：藥師／護理師對病人進行用藥指導，依病人情況辨識並修正不當用藥行為，留下紀錄。
 * 原則：前端不做授權判定、不暫存病人資料於瀏覽器儲存空間；所有資料經 Apps Script 後端驗證後回傳。
 * 不做交互作用檢查；「應避免」僅為面向層級靜態提示。
 */
(function () {
  'use strict';
  var S = { gen: 0, cfg: null, token: null, tokenExp: 0, boot: null, dirty: false, qcache: {}, cards: {}, tasks: null, last: {}, prefill: null };
  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };
  var esc = function (s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var codes = function (type) { return (S.boot && S.boot.codes[type]) || []; };
  var codeText = function (type, code) { var c = codes(type).filter(function (x) { return x.code === code; })[0]; return c ? c.text : code; };
  var MRN_RE = /^[A-Za-z0-9]{4,20}$/;
  var VERDICT_TEXT = { PASS: '通過', PARTIAL: '部分通過', FAIL: '未通過', NA: '無法評估' };
  var VERDICT_TAG = { PASS: 'ok', PARTIAL: '', FAIL: 'bad', NA: '' };

  /* ---------- 啟動與登入 ---------- */
  function start() {
    fetch('config.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (cfg) {
      S.cfg = cfg;
      if (cfg.appName) { $('#appName').textContent = cfg.appName; document.title = cfg.appName; }
      waitGsi(0);
    }).catch(function () { showLoginMsg('無法讀取 config.json', 'err'); });
  }
  function waitGsi(n) {
    if (window.google && google.accounts && google.accounts.id) return initGsi();
    if (n > 100) return showLoginMsg('Google 登入元件載入失敗，請檢查網路後重新整理', 'err');
    setTimeout(function () { waitGsi(n + 1); }, 100);
  }
  function initGsi() {
    google.accounts.id.initialize({ client_id: S.cfg.clientId, callback: onCredential, auto_select: true, cancel_on_tap_outside: false });
    google.accounts.id.renderButton($('#gsiBtn'), { theme: 'outline', size: 'large', text: 'signin_with', locale: 'zh-TW' });
    google.accounts.id.prompt();
  }
  function onCredential(resp) {
    S.token = resp.credential;
    try {
      var p = JSON.parse(atob(S.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      S.tokenExp = (p.exp || 0) * 1000;
    } catch (e) { S.tokenExp = Date.now() + 3000 * 1000; }
    showLoginMsg('驗證中…（正在載入藥品與疾病包資料）', 'info');
    api('bootstrap').then(function (b) {
      S.boot = b;
      S.drugIdx = {};
      (b.drugs || []).forEach(function (d) { S.drugIdx[d[0]] = d; });
      $('#login').classList.add('hidden');
      $('#tabs').classList.remove('hidden');
      $('#who').innerHTML = esc(b.user.name || b.user.email) + '<br>' + esc(b.user.role) + '｜' + esc(b.user.level);
      if (b.settings.locked) toast('系統維護中：目前無法新增或修改紀錄', 'err');
      route();
      if (currentView() !== 'home') refreshTaskBadge(); // 首頁已一次取回待辦
    }).catch(function (e) { showLoginMsg(e.message, 'err'); S.token = null; });
  }
  function showLoginMsg(t, kind) { $('#loginMsg').innerHTML = '<div class="msg ' + (kind || 'info') + '">' + esc(t) + '</div>'; }
  function needRelogin(msg) {
    S.token = null;
    $('#login').classList.remove('hidden');
    $('#tabs').classList.add('hidden');
    $('#view').classList.add('hidden');
    showLoginMsg(msg || '登入已逾時，請重新登入（未送出資料已保留在本頁記憶體）', 'err');
    if (window.google) google.accounts.id.prompt();
  }

  /* ---------- 後端呼叫 ---------- */
  function api(action, payload) {
    if (S.token && S.tokenExp && Date.now() > S.tokenExp - 30000) {
      needRelogin();
      return Promise.reject(new Error('登入已逾時，請重新登入'));
    }
    return fetch(S.cfg.apiUrl, {
      method: 'POST', redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, idToken: S.token, payload: payload || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.ok) { $('#view').classList.remove('hidden'); return j.data; }
      if (j.status === 401) needRelogin(j.error && j.error.message);
      var err = new Error((j.error && j.error.message) || '發生錯誤');
      err.status = j.status;
      throw err;
    }, function () { throw new Error('網路連線失敗，請稍後再試'); });
  }

  /* v2.4 U3：畫面世代保護。route() 每次遞增 S.gen；非同步結果回來時若已換頁就丟棄（不 resolve），避免蓋掉新頁 */
  function vapi(action, payload) {
    var g = S.gen;
    return api(action, payload).then(function (d) {
      if (g !== S.gen) return new Promise(function () {});
      return d;
    }, function (e) {
      if (g !== S.gen) return new Promise(function () {});
      throw e;
    });
  }

  function toast(text, kind) {
    var d = document.createElement('div');
    d.className = 'msg toast ' + (kind || 'ok');
    d.setAttribute('role', 'status');
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, kind === 'err' ? 6000 : 3000);
  }

  /* ---------- 路由 ---------- */
  window.addEventListener('hashchange', route); // 未送出的新增紀錄保留在記憶體，切回分頁可續填
  window.addEventListener('beforeunload', function (e) { if (S.dirty) { e.preventDefault(); e.returnValue = ''; } });
  function currentView() { return (location.hash || '#home').slice(1); }
  var draftNode = null;
  function go(v) { if (currentView() === v) route(); else location.hash = '#' + v; }
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('nav.tabs a[data-v]');
    if (a && a.getAttribute('data-v') === currentView()) { e.preventDefault(); route(); } // 點目前分頁也重整
  });
  function route() {
    if (!S.boot) return;
    S.gen++;
    var v = currentView();
    $$('nav.tabs a').forEach(function (a) { a.classList.toggle('on', a.getAttribute('data-v') === v); });
    // v2.5 U12：有未送出的草稿時，「新增紀錄」分頁顯示提示點
    var ra = $('nav.tabs a[data-v=record]');
    if (ra) { ra.classList.toggle('draft', !!(draftNode && S.dirty) && v !== 'record'); ra.title = ra.classList.contains('draft') ? '有未送出的紀錄草稿' : ''; }
    var view = $('#view');
    if (draftNode && draftNode.parentNode) view.removeChild(draftNode);
    view.innerHTML = '';
    window.scrollTo(0, 0);
    if (v === 'home') return viewHome(view);
    if (v === 'record') return viewRecord(view);
    if (v === 'tasks') return viewTasks(view);
    if (v === 'history') return viewHistory(view);
    if (v === 'dashboard') return viewDashboard(view);
    location.hash = '#home';
  }

  /* ---------- 共用元件 ---------- */
  function chip(name, value, text, checked, type, extra) {
    return '<label class="chip' + (checked ? ' on' : '') + '"><input type="' + (type || 'checkbox') + '" name="' + esc(name) + '" value="' +
      esc(value) + '"' + (checked ? ' checked' : '') + (extra || '') + '>' + esc(text) + '</label>';
  }
  function syncChip(x) {
    if (!x.closest('.chip')) return;
    if (x.type === 'radio') $$('input[name="' + x.name + '"]', x.form || document).forEach(function (y) { if (y.closest('.chip')) y.closest('.chip').classList.toggle('on', y.checked); });
    else x.closest('.chip').classList.toggle('on', x.checked);
  }
  function bindChips(root) {
    root.addEventListener('change', function (e) { if (e.target.closest && e.target.closest('.chip')) syncChip(e.target); });
  }
  function setChecked(root, name, value, on) {
    var x = $('input[name="' + name + '"][value="' + value + '"]', root);
    if (x && x.checked !== on) { x.checked = on; syncChip(x); }
  }
  function vals(root, name) { return $$('input[name="' + name + '"]:checked', root).map(function (x) { return x.value; }); }
  function radio(root, n) { var x = $('input[name="' + n + '"]:checked', root); return x ? x.value : ''; }
  function modal(html) {
    var wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.setAttribute('role', 'dialog');
    wrap.innerHTML = '<div class="box"><div class="mbody">' + html + '</div><div class="actions-bar no-print"><button type="button" class="btn ghost" data-close>關閉</button></div></div>';
    document.body.appendChild(wrap);
    var close = function () { wrap.remove(); document.removeEventListener('keydown', onKey); };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) { if (e.target === wrap || e.target.hasAttribute('data-close')) close(); });
    return { body: $('.mbody', wrap), close: close, box: $('.box', wrap) };
  }
  function today() { var d = new Date(Date.now() + 8 * 3600 * 1000); return d.toISOString().slice(0, 10); }
  function ymdAdd(ymd, n) { var d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  /* v2.5 U9：記住上次選的病人來源（代碼，不含病人資料）；瀏覽器不允許時只記在記憶體 */
  function lastSource(v) {
    if (v) { S.lastSource = v; try { localStorage.setItem('hcp.lastSource', v); } catch (e) { /* ignore */ } return v; }
    if (S.lastSource) return S.lastSource;
    try { return localStorage.getItem('hcp.lastSource') || ''; } catch (e) { return ''; }
  }
  function packName(code) {
    var p = (S.boot.allPacks || []).filter(function (x) { return x.code === code; })[0];
    return p ? p.name : code;
  }
  function packLive(code) { return S.boot.packs.some(function (p) { return p.code === code; }); }

  /* ---------- 藥品索引與搜尋 ---------- */
  // 索引列：[處置代碼, 商品名, 成分規格, ATC, 裝置類型, 商品名簡碼, 學名簡碼, 面向(未確認加?), 應避免面向]
  function drug(code) {
    var d = S.drugIdx[code];
    if (!d) return null;
    return { code: d[0], brand: d[1], ing: d[2], atc: d[3], device: d[4], bs: d[5], gs: d[6],
      packs: d[7] ? d[7].split(',') : [], avoid: d[8] ? d[8].split(',') : [], core: d[9] ? d[9].split(',') : [] };
  }
  function searchDrugs(q, limit) {
    q = q.trim().toLowerCase();
    if (q.length < 2) return [];
    var out = [];
    (S.boot.drugs || []).forEach(function (d) {
      var code = d[0].toLowerCase(), brand = d[1].toLowerCase(), ing = d[2].toLowerCase(), bs = d[5].toLowerCase(), gs = d[6].toLowerCase();
      var s = 0;
      if (code === q || bs === q || gs === q) s = 100;
      else if (brand.indexOf(q) === 0) s = 80;
      else if (code.indexOf(q) === 0 || (bs && bs.indexOf(q) === 0) || (gs && gs.indexOf(q) === 0)) s = 70;
      else if (ing.indexOf(q) === 0) s = 60;
      else if (brand.indexOf(q) > 0) s = 40;
      else if (ing.indexOf(q) > 0) s = 30;
      if (s) out.push([s, d]);
    });
    out.sort(function (a, b) { return b[0] - a[0] || (a[1][1] < b[1][1] ? -1 : 1); });
    return out.slice(0, limit || 12).map(function (x) { return drug(x[1][0]); });
  }
  function deviceLabel(dev) {
    if (!dev) return '';
    var d = S.boot.devices[dev];
    if (d) return d.name + (d.draft ? '（草稿）' : '');
    if (/^DEV-/.test(dev)) return '特殊裝置（內容未上線）';
    return { ORAL: '口服', INJ: '注射（醫護人員給藥）', PROC: '院內處置（無居家操作）', 'ITEM-NOTE': '其他劑型' }[dev] || dev;
  }
  function drugRowHtml(d, btnText) {
    return '<div class="dres"><div class="dmain"><b>' + esc(d.brand) + '</b> <span class="note">' + esc(d.code) + '</span>' +
      '<div class="note">' + esc(d.ing) + '</div>' +
      '<div class="note">' + esc(deviceLabel(d.device)) + (d.atc ? '｜' + esc(d.atc) : '') + '</div></div>' +
      '<button type="button" class="btn small" data-pick="' + esc(d.code) + '">' + esc(btnText || '加入') + '</button></div>';
  }

  /* ---------- 藥品卡 ---------- */
  function loadCard(code) {
    if (S.cards[code]) return Promise.resolve(S.cards[code]);
    return api('drug', { code: code }).then(function (c) { S.cards[code] = c; return c; });
  }
  var FIELD_LABEL = [['purpose', '作用'], ['how', '怎麼用'], ['missed', '忘記用'], ['ae', '常見副作用'], ['monitor', '需要監測'],
    ['seek', '何時停藥或就醫'], ['interact', '併用注意'], ['store', '保存'], ['redflags', '紅旗警訊'], ['misuse', '常見不當用藥行為與修正']];
  function cardHtml(c) {
    var fields = FIELD_LABEL.filter(function (f) { return c.fields[f[0]]; }).map(function (f) {
      var x = c.fields[f[0]];
      return '<div class="cf"><div class="cfh">' + esc(f[1]) + ' <span class="note">（' + esc(x.layer) + '）</span>' +
        (x.draft ? ' <span class="tag">草稿・未簽核</span>' : '') + '</div><div class="pre">' + esc(x.text) + '</div></div>';
    }).join('');
    var dv = c.deviceDetail;
    var dvHtml = dv ? '<div class="cf"><div class="cfh">' + esc(dv.name) + ' 標準步驟' + (dv.draft ? ' <span class="tag">草稿・未簽核</span>' : '') + '</div><ol>' +
      dv.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol>' +
      (c.diff && c.diff !== '無' ? '<div class="msg info">此品項與標準步驟差異：' + esc(c.diff) + '</div>' : '') + '</div>' : '';
    var packs = (c.packs || []).map(function (m) {
      return '<span class="tag' + (m.role === '應避免' ? ' bad' : '') + '"' + (m.condition ? ' title="' + esc(m.condition) + '"' : '') + '>' + esc(m.name) + '・' + esc(m.role) + (m.confirmed ? '' : '（未確認）') + '</span>';
    }).join(' ');
    var conds = (c.packs || []).filter(function (m) { return m.condition; }).map(function (m) { return '<li><b>' + esc(m.name) + '</b>：' + esc(m.condition) + '</li>'; }).join('');
    // v2.5.1（裁決 S7）：上層類別（處置代碼類別、ATC7、ATC4、劑型）預設全部展開，另標示「非本品專屬」
    var own = { '品項': 1, '繼承品項': 1, '裝置類型': 1 };
    var staffOne = function (x) { return '<div class="cfh">' + esc(x.layer) + (x.draft ? ' <span class="tag">草稿</span>' : '') + '</div><div class="pre">' + esc(x.text) + '</div>'; };
    var upper = (c.staff || []).filter(function (x) { return !own[x.layer]; });
    var staff = (c.staff || []).filter(function (x) { return own[x.layer]; }).map(staffOne).join('') +
      (upper.length ? '<details class="upper" open><summary>上層類別要點（非本品專屬，' + upper.length + ' 則）</summary>' + upper.map(staffOne).join('') + '</details>' : '');
    var staffBox = (staff || conds || c.dataIssue) ? '<details class="staffbox" open><summary>人員核對要點（不給病人）</summary>' +
      (c.dataIssue ? '<div class="msg warn">藥品手冊資料疑義：' + esc(c.dataIssue) + '</div>' : '') + staff +
      (conds ? '<div class="cfh">面向對照條件</div><ul class="hint">' + conds + '</ul>' : '') + '</details>' : '';
    var tb = c.teachback ? '<div class="msg info">回教問句：' + esc(c.teachback) + '</div>' : '';
    return '<h2>' + esc(c.brand) + ' <span class="note">' + esc(c.code) + '</span></h2><div class="note">' + esc(c.ing) + '｜' + esc(c.atc) + '</div>' +
      (packs ? '<div class="packs">' + packs + '</div>' : '') +
      (!c.active ? '<div class="msg err">此品項已於藥品手冊停用</div>' : '') + staffBox + tb +
      (fields || dvHtml ? dvHtml + fields : '<div class="msg info">此品項尚無已簽核內容。請依仿單與醫囑說明，並可於控制台補寫。</div>') +
      '<p class="note">內容依藥品類別（ATC）繼承；草稿僅供人員參考，不會出現在病人版摘要。本平台不做交互作用檢查。</p>';
  }
  function showCard(code) {
    var m = modal('<div class="empty">載入藥品卡…</div>');
    loadCard(code).then(function (c) { m.body.innerHTML = cardHtml(c); }).catch(function (e) { m.body.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  /* ---------- 首頁（v2.4 U6：7 區塊，依「可不可用 → 馬上開始 → 有沒有漏 → 續上次 → 有沒有效 → 可不可信」排列） ---------- */
  function statusBar(b) {
    var h = b.health || { level: 'ok', problems: [], stats: {} };
    var st = h.stats || {};
    var ok = '藥品 ' + (st.drugs || 0) + ' 項（' + (st.liveCards || 0) + ' 項品項層已簽核）｜疾病包 ' + (st.packsLive || 0) + '／' + (st.packsTotal || 0) + ' 上線｜最後彙總 ' + (h.lastRun || '尚未執行');
    if (h.level === 'ok') return ''; // v2.5 U12：正常時不佔首頁上方，狀態移到頁尾
    return '<div class="statusbar ' + esc(h.level) + '" role="status">' + (h.level === 'ok' ? '<b>系統正常</b>　' + esc(ok) :
      h.problems.map(function (p) { return '<div><b>' + (p.level === 'bad' ? '無法使用' : '注意') + '</b>　' + esc(p.text) + (p.fix ? '<div class="note">修復：' + esc(p.fix) + '</div>' : '') + '</div>'; }).join('') +
      '<div class="note">' + esc(ok) + '</div>') + '</div>';
  }
  function taskItemHtml(kind, x) {
    var c = x.ctx || {};
    var bits = [];
    if (c.drugs && c.drugs.length) bits.push('藥品：' + c.drugs.join('、'));
    if (c.behaviors && c.behaviors.length) bits.push('上次發現：' + c.behaviors.join('、') + (c.intervention ? '（' + c.intervention + '）' : ''));
    if (c.teachback) bits.push('教回：' + c.teachback);
    return '<li><span class="' + (x.overdue ? 'overdue' : '') + '">' + esc(kind === 'fu' ? x.due : x.sent) + '</span>　' + (kind === 'fu' ? '追蹤' : '轉介') + '　' +
      esc(x.packName) + '　末四碼 ' + esc(x.last4) + (kind === 'ref' && x.days > 7 ? ' <span class="tag bad">超過 7 天</span>' : '') +
      (bits.length ? '<div class="note">' + esc(bits.join('｜')) + '</div>' : '') + '</li>';
  }
  function viewHome(view) {
    var b = S.boot;
    var st = (b.health && b.health.stats) || {};
    // v2.5 U12：首頁依「馬上開始 → 有沒有漏 → 續上次 → 有沒有被計入 → 可不可信」排列；系統正常時狀態只在頁尾
    var hh = b.health || { stats: {} };
    view.innerHTML = statusBar(b) +
      '<div class="card hero"><label class="f" for="hq">輸入病歷號、藥名、成分、處置代碼或疾病，按 Enter 開始</label>' +
      '<div class="inline"><input type="search" id="hq" autocomplete="off" spellcheck="false" placeholder="例：A1234567、Symbicort、metformin、糖尿病">' +
      '<button type="button" class="btn ghost" id="hfree">不選藥直接記錄</button></div>' +
      '<div id="hqres"></div><div id="hfreq" class="quick"></div></div>' +
      '<div class="card"><h2>今日要做</h2><div id="htasks" class="sk"><div class="skel"></div><div class="skel"></div></div></div>' +
      '<div class="card"><h2>近 7 日我照護的病人</h2><div id="hrecent" class="sk"><div class="skel"></div><div class="skel"></div></div></div>' +
      '<div class="grid2"><div class="card"><h2>本月我的成效</h2><div id="hmonth" class="sk"><div class="skel"></div></div></div>' +
      '<div class="card"><h2>內容可不可以直接講給病人聽</h2><div class="kpis"><div><b>' + (st.liveCards || 0) + '</b><span>支藥的藥品卡已由藥師簽核</span></div>' +
      '<div><b>' + (st.sourcesVerified || 0) + '／' + (st.sources || 0) + '</b><span>引用來源已查證</span></div>' +
      '<div><b>' + (st.qLive || 0) + '／' + (st.questions || 0) + '</b><span>衛教題目已可上線</span></div></div>' +
      '<div class="note">每段內容標示來源層級與簽核狀態；未簽核的草稿不會出現在病人版摘要。</div></div></div>' +
      '<div class="status note" id="hstatus">系統正常｜最後彙總 ' + esc(hh.lastRun || '尚未執行') + '｜版本 ' + esc(b.settings.version) + (b.settings.showDrafts ? '｜<span class="tag">人員端顯示未簽核內容</span>' : '') +
      '｜本平台不做交互作用檢查，個別處方審查請用醫令系統</div>';
    var q = $('#hq');
    q.focus();
    $('#hfree').addEventListener('click', function () { startRecord({ entry: '面向' }); });
    var run = function () {
      var v = q.value.trim(), out = $('#hqres');
      if (!v) { out.innerHTML = ''; return; }
      var html = '';
      if (MRN_RE.test(v) && /\d{4,}/.test(v)) {
        html += '<div class="group-label">病人</div><div class="dres"><div class="dmain"><b>病歷號 ' + esc(v) + '</b><div class="note">查詢會留存稽核紀錄</div></div>' +
          '<button type="button" class="btn small ghost" data-mrn-hist>查歷史</button><button type="button" class="btn small" data-mrn-new>新增紀錄</button></div>';
      }
      var ds = searchDrugs(v, 8);
      if (ds.length) html += '<div class="group-label">藥品</div>' + ds.map(function (d) { return drugRowHtml(d, '開始指導'); }).join('');
      var ps = b.packs.filter(function (p) { return (p.name + p.code).toLowerCase().indexOf(v.toLowerCase()) >= 0; }).slice(0, 4);
      if (ps.length) html += '<div class="group-label">照護面向</div>' + ps.map(function (p) {
        return '<div class="dres"><div class="dmain"><b>' + esc(p.name) + '</b><div class="note">照護面向</div></div><button type="button" class="btn small" data-pk="' + esc(p.code) + '">開始紀錄</button></div>';
      }).join('');
      out.innerHTML = html || emptySearchHtml(v);
    };
    q.addEventListener('input', run);
    q.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var first = $('#hqres button', view);
      if (first) first.click();
    });
    $('#hqres').addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      var v = q.value.trim();
      if (t.hasAttribute('data-mrn-hist')) { S.histMrn = v; go('history'); }
      else if (t.hasAttribute('data-mrn-new')) startRecord({ mrn: v, entry: '病人' });
      else if (t.getAttribute('data-pick')) startRecord({ drugs: [t.getAttribute('data-pick')], entry: '藥' });
      else if (t.getAttribute('data-pk')) startRecord({ pack: t.getAttribute('data-pk'), entry: '面向' });
    });
    vapi('home').then(function (h) {
      var t = h.tasks || { followups: [], referrals: [] };
      S.tasks = t; setTaskBadge(t);
      var fx = h.behaviorsFixed || { found: 0, fixed: 0, checked: 0 };
      $('#hmonth').className = '';
      $('#hmonth').innerHTML = '<div class="kpis"><div><b>' + h.month.records + '</b><span>指導人次</span></div>' +
        '<div><b>' + fx.fixed + '</b><span>不當用藥行為已修正（本月發現 ' + fx.found + '）</span></div>' +
        '<div><b>' + (fx.checked ? Math.round(fx.fixed / fx.checked * 100) + '%' : '—') + '</b><span>追蹤改善率（' + fx.fixed + '／' + fx.checked + '）</span></div></div>' +
        '<div class="note">裝置技巧評估 ' + h.month.devices + ' 次，首次通過率 ' + (h.month.passRate === null ? '—' : h.month.passRate + '%') + '（' + h.month.judged + ' 次可判定）；已排除測試病歷號</div>' +
        '<div class="actions-bar"><a class="btn small ghost" href="#dashboard">看儀表板</a></div>';
      $('#hrecent').className = '';
      $('#hrecent').innerHTML = h.recent.length ? h.recent.map(function (r, i) {
        return '<div class="dres' + (i >= 5 ? ' more hidden' : '') + '"><div class="dmain"><b>末四碼 ' + esc(r.last4) + '</b>' + (r.test ? ' <span class="tag">測試</span>' : '') + '　' + esc(r.packName) + ' <span class="note">' + esc(r.time) + '</span>' +
          (r.drugs.length ? '<div class="note">' + esc(r.drugs.map(function (d) { return d.brand; }).join('、')) + '</div>' : '') + '</div>' +
          '<button type="button" class="btn small ghost" data-sum="' + esc(r.recordId) + '">摘要</button>' +
          (r.drugs.length ? '<button type="button" class="btn small" data-again="' + esc(r.recordId) + '">同藥再指導</button>' : '') + '</div>';
      }).join('') + (h.recent.length > 5 ? '<div class="actions-bar left"><button type="button" class="btn small ghost" id="hrecentMore">顯示全部 ' + h.recent.length + ' 位</button></div>' : '') : '<div class="empty">近 7 日沒有紀錄</div>';
      if ($('#hrecentMore')) $('#hrecentMore').addEventListener('click', function () { $$('#hrecent .more').forEach(function (x) { x.classList.remove('hidden'); }); this.remove(); });
      $$('[data-sum]', $('#hrecent')).forEach(function (bt) {
        bt.addEventListener('click', function () { api('summary', { recordId: bt.getAttribute('data-sum') }).then(showSummary).catch(function (e) { toast(e.message, 'err'); }); });
      });
      $$('[data-again]', $('#hrecent')).forEach(function (bt) {
        bt.addEventListener('click', function () {
          var r = h.recent.filter(function (x) { return x.recordId === bt.getAttribute('data-again'); })[0];
          startRecord({ drugs: r.drugs.map(function (d) { return d.code; }).filter(function (c) { return S.drugIdx[c]; }), pack: packLive(r.pack) ? r.pack : '', entry: '藥' });
        });
      });
      $('#hfreq').className = '';
      $('#hfreq').innerHTML = (h.topDrugs.length || h.topPacks.length ? '<div class="group-label">我常用（近 30 日，一點即開始）</div>' : '') + (h.topDrugs.length ? '<div class="chips">' + h.topDrugs.slice(0, 6).map(function (d) {
        return '<button type="button" class="chip" data-fd="' + esc(d.code) + '">' + esc(d.brand) + ' <span class="note">' + d.n + '</span></button>';
      }).join('') + '</div>' : '') + (h.topPacks.length ? '<div class="chips">' + h.topPacks.map(function (p) {
        return '<button type="button" class="chip pk" data-fp="' + esc(p.code) + '">' + esc(p.name) + ' <span class="note">' + p.n + '</span></button>';
      }).join('') + '</div>' : '');
      $$('[data-fd]', $('#hfreq')).forEach(function (bt) { bt.addEventListener('click', function () { startRecord({ drugs: [bt.getAttribute('data-fd')], entry: '藥' }); }); });
      $$('[data-fp]', $('#hfreq')).forEach(function (bt) { bt.addEventListener('click', function () { startRecord({ pack: bt.getAttribute('data-fp'), entry: '面向' }); }); });
      var items = t.followups.filter(function (f) { return f.due <= today(); }).map(function (f) { return taskItemHtml('fu', f); })
        .concat(t.referrals.map(function (x) { return taskItemHtml('ref', x); }));
      var td0 = today(), wk0 = ymdAdd(td0, 7);
      var nOver = t.followups.filter(function (f) { return f.overdue || f.due < td0; }).length, nToday = t.followups.filter(function (f) { return !f.overdue && f.due === td0; }).length,
        nWeek = t.followups.filter(function (f) { return f.due > td0 && f.due <= wk0; }).length;
      $('#htasks').className = '';
      $('#htasks').innerHTML = '<a class="kpis tlink" href="#tasks"><div><b class="' + (nOver ? 'overdue' : '') + '">' + nOver + '</b><span>逾期追蹤</span></div><div><b>' + (nToday + t.referrals.length) + '</b><span>今天到期＋待受理轉介</span></div>' +
        '<div><b>' + nWeek + '</b><span>7 天內到期</span></div></a>' + (items.length ? '<ul class="tl">' + items.slice(0, 5).join('') + '</ul>' +
        '<div class="actions-bar"><a class="btn small ghost" href="#tasks">全部待辦（' + items.length + '）</a></div>' : '<div class="empty">今日沒有到期待辦</div>');
    }).catch(function (e) {
      ['#htasks', '#hrecent', '#hmonth', '#hfreq'].forEach(function (id) { var el = $(id); if (el) { el.className = ''; el.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; } });
    });
  }
  /** v2.4 U1：空結果說明（查無／資料未匯入） */
  function emptySearchHtml(v) {
    if (!(S.boot.drugs || []).length) return '<div class="msg err">藥品資料尚未匯入，藥品搜尋暫停。請通知管理者（首頁狀態條有修復步驟）。</div>';
    return '<div class="empty">查無「' + esc(v) + '」：請確認拼字、改用成分或處置代碼；病歷號需 4 位以上數字。已停用品項不會出現。</div>';
  }

  function startRecord(pre) {
    if (draftNode && S.dirty && !confirm('目前有未送出的紀錄，是否放棄並開始新的紀錄？')) { go('record'); return; }
    draftNode = null; S.dirty = false;
    S.prefill = pre || {};
    go('record');
  }

  /* ---------- 新增紀錄 ---------- */
  function viewRecord(view) {
    if (draftNode) { view.appendChild(draftNode); return; }
    var b = S.boot;
    var pre = S.prefill || {};
    S.prefill = null;
    var groups = {};
    b.packs.forEach(function (p) { (groups[p.cat] = groups[p.cat] || []).push(p); });
    var packOpts = '<option value="">請選擇</option>' + Object.keys(groups).map(function (g) {
      return '<optgroup label="' + esc(g) + '">' + groups[g].map(function (p) {
        return '<option value="' + esc(p.code) + '">' + esc(p.name) + (p.status === '過渡沿用' ? '（舊版內容・複審中）' : '') + '</option>';
      }).join('') + '</optgroup>';
    }).join('');
    var opt = function (type) { return codes(type).map(function (c) { return '<option value="' + esc(c.code) + '">' + esc(c.text) + '</option>'; }).join(''); };
    var roleOpts = codes('職類').filter(function (c) { return c.code !== 'EXT'; }).map(function (c) { return '<option value="' + esc(c.code) + '">' + esc(c.text) + '</option>'; }).join('');
    var issueGroups = {};
    codes('發現問題').forEach(function (c) { (issueGroups[c.group] = issueGroups[c.group] || []).push(c); });
    var f = document.createElement('form');
    f.id = 'recForm';
    f.autocomplete = 'off';
    f.setAttribute('data-entry', pre.entry || '面向');
    f.innerHTML =
      '<div class="progress" id="prog" aria-label="填寫進度（點選跳到該段）"><span data-step="1" data-label="病人" role="button" tabindex="0">病人</span><span data-step="2" data-label="藥品與技巧" role="button" tabindex="0">藥品與技巧</span><span data-step="3" data-label="行為與後續" role="button" tabindex="0">行為與後續</span></div>' +
      '<div class="card" data-sec="1"><h2>病人</h2><div class="row two">' +
      '<div data-field="mrn"><label class="f">病歷號 <span class="req">*</span></label><div class="inline"><input type="text" name="mrn" maxlength="20" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="btn small ghost" id="lastBtn" title="查詢此病人過去的指導結果（留存稽核）">上次指導</button></div><div id="lastNote"></div></div>' +
      '<div data-field="source"><label class="f">病人來源 <span class="req">*</span> <span class="auto hidden" id="srcAuto">沿用上次</span></label><select name="source"><option value="">請選擇</option>' + opt('病人來源') + '</select></div></div>' +
      (b.settings.branches.length ? '<label class="f">分院</label><select name="branch"><option value="">（本院）</option>' +
        b.settings.branches.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select>' : '') + '</div>' +

      '<div class="card" data-sec="2"><h2>本次指導的藥品</h2>' +
      '<input type="search" name="dq" placeholder="輸入藥名、成分、處置代碼或簡碼（至少 2 字）" autocomplete="off" spellcheck="false">' +
      '<div id="dqres" class="dqres"></div><div id="drugList" class="druglist"><div class="note">未選藥品時可直接依面向題目紀錄</div></div>' +
      '<div id="avoidNote"></div></div>' +

      '<div class="card hidden" id="devCard" data-sec="2"><h2>裝置技巧評估</h2><div class="note">逐項觀察病人（或照顧者）實際操作：做到／沒做到／未評估。標 <b class="crit">關鍵</b> 者沒做到即判未通過。</div><div id="devList"></div></div>' +

      '<div class="card" data-sec="2"><h2>照護面向與標準回應</h2>' +
      '<div data-field="pack"><label class="f">主要照護面向 <span class="req">*</span></label><select name="pack">' + packOpts + '</select></div>' +
      '<div id="packNote"></div><div id="packAlt"></div><div id="packMulti"></div>' +
      '<details class="sub"><summary>合併面向（共病）</summary><div class="chips" id="packs2"></div></details>' +
      '<div class="row two"><div><label class="f">問題分類</label><select name="cat"><option value="">全部</option></select></div>' +
      '<div><label class="f">搜尋題目</label><input type="search" name="qsearch" placeholder="輸入關鍵字"></div></div>' +
      '<div class="qlist" id="qlist"><div class="empty">請先選擇主要照護面向</div></div>' +
      '<label class="f">病人提出的問題（可空白）</label><input type="text" name="question" maxlength="500">' +
      '<div data-field="response"><label class="f">醫療人員回應 <span class="req" id="respReq">*</span><span class="note" id="respHint"></span></label>' +
      '<div class="actions-bar left"><button type="button" class="btn small ghost hidden" id="cardFill">帶入藥品卡重點</button></div>' +
      '<textarea name="response" maxlength="5000" rows="7"></textarea><div class="note" id="respCount">0 / 5000</div></div></div>' +

      '<div class="card" data-sec="3"><h2>不當用藥行為與介入</h2><div class="note">本次發現病人實際的錯誤用藥行為才勾選；未發現則略過。</div>' +
      '<div class="chips collapsed" id="behaviors">' + codes('不當用藥行為').map(function (c, i) { return chip('behaviors', c.code, c.text).replace('class="chip"', 'class="chip' + (i >= 6 ? ' more' : '') + '"'); }).join('') + '</div>' +
      (codes('不當用藥行為').length > 6 ? '<div class="actions-bar left"><button type="button" class="btn small ghost" id="behMore">其他不當用藥行為（' + (codes('不當用藥行為').length - 6) + '）</button></div>' : '') +
      '<div id="misuseHint"></div>' +
      '<div id="ivBox" class="hidden" data-field="intervention"><label class="f">介入結果 <span class="req">*</span></label><div class="chips">' +
      codes('介入結果').map(function (c) { return chip('intervention', c.code, c.text, false, 'radio'); }).join('') + '</div></div></div>' +

      '<div class="card" data-sec="3"><h2>結果與後續</h2>' +
      // v2.7：首次教回＋補強後最終（首次即完全或無法應答時不再問）
      '<div data-field="teachback"><label class="f">第一次教回（teach-back） <span class="req" id="tbReq">*</span><span class="note" id="tbHint"></span></label><div class="chips">' +
      codes('教回結果').map(function (c) { return chip('firstTb', c.code, c.text, false, 'radio'); }).join('') + '</div>' +
      '<div id="tbAfter" class="hidden sub-q"><label class="f">重新說明後的結果 <span class="req">*</span><span class="note">（首次未完全時，補強後再請病人說一次）</span></label><div class="chips">' +
      codes('教回結果').filter(function (c) { return c.code !== 'NA'; }).map(function (c) { return chip('teachback', c.code, c.text, false, 'radio'); }).join('') + '</div></div></div>' +
      '<div id="tbPrompts"></div>' +
      '<div data-field="actions"><label class="f">病人行動計畫 <span class="req">*</span>（至少一項）</label><div id="actions"><span class="note">請先選擇主要照護面向</span></div></div>' +
      '<div class="toggle"><input type="checkbox" name="caregiver" id="cg"><label for="cg">照顧者在場</label></div>' +
      '<div data-field="coverage" id="covWrap"><label class="f">本次涵蓋 <span class="note">（依題目與行動計畫預先勾選，可修改）</span></label><div class="chips" id="covBox"></div></div>' +
      (b.user && (supVisible() || isLearner()) ? '<div data-field="supervision"><label class="f">督導方式' + (isUgy() ? ' <span class="req">*</span>' : '') + ' <span class="note">（學員紀錄；預設沿用上次）</span></label><div class="chips">' +
        codes('督導方式').filter(function (c) { return !isUgy() || c.code !== 'IND'; }).map(function (c) { return chip('supervision', c.code, c.text, c.code === (S.lastSup && (!isUgy() || S.lastSup !== 'IND') ? S.lastSup : (isUgy() ? 'PRES' : 'IND')), 'radio'); }).join('') + '</div></div>' +
        (isLearner() ? '<div data-field="supervisor"><label class="f">督導教師' + (isUgy() ? ' <span class="req">*</span>' : '') + '</label><select name="supervisor"><option value="">' + (isUgy() ? '請選擇' : '（獨立執行可不填）') + '</option>' +
          (b.supervisors || []).map(function (x) { return '<option value="' + esc(x.pid) + '"' + (x.pid === S.lastSupT ? ' selected' : '') + '>' + esc(x.name) + (x.teacher ? '（臨床教師）' : '') + '</option>'; }).join('') + '</select></div>' : '') : '') +
      '<div class="toggle"><input type="checkbox" name="needFu" id="nf"><label for="nf">需要追蹤</label> <span class="auto hidden" id="fuAuto">自動：因發現不當用藥行為建立追蹤，可取消</span></div>' +
      '<div class="row two" id="fuBox" style="display:none"><div><label class="f">幾天後追蹤</label><input type="number" name="fuDays" min="1" max="365" value="14"></div>' +
      '<div><label class="f">追蹤職類</label><select name="fuRole">' + roleOpts + '</select></div></div>' +
      '<div class="note hidden" id="nextCheck"></div>' +
      '<div class="toggle"><input type="checkbox" name="needRef" id="nr"><label for="nr">建立轉介待辦</label></div>' +
      '<div id="refBox" style="display:none" data-field="refRoles"><label class="f">轉介給（可多選）</label><div class="chips">' +
      codes('職類').map(function (c) { return chip('refRoles', c.code, c.text); }).join('') + '</div></div></div>' +

      '<details class="card opt" id="optWhole"><summary><h2>全人評估</h2><span class="opt-tag">選填</span><span class="opt-done hidden" id="wholeDone"></span>' +
        '<div class="opt-hint">多為勾選；勾選的問題計入問題發現率，跨職類需求會自動帶入轉介對象</div></summary><label class="f">發現問題（可複選）</label>' +
      Object.keys(issueGroups).map(function (g) {
        return '<div class="group-label">' + esc(g) + '</div><div class="chips">' + issueGroups[g].map(function (c) { return chip('issues', c.code, c.text); }).join('') + '</div>';
      }).join('') +
      '<label class="f">跨職類照護需求（可複選）</label><div class="chips">' +
      codes('職類').map(function (c) { return chip('needs', c.code, c.text); }).join('') + '</div>' +
      '<div id="kvBox" class="hidden"><label class="f" id="kvLabel"></label><div class="inline"><input type="number" name="keyValue" inputmode="decimal" class="kv"><span class="note" id="kvUnit"></span></div>' +
        '<div class="note">病人或家屬自述，選填；追蹤時再問一次可看出變化</div></div>' +
      '<label class="f">全人照護建議</label><textarea name="advice" maxlength="2000" rows="3"></textarea></details>' +

      '<details class="card opt" id="optFeedback"><summary><h2>病人回饋與簽名</h2><span class="opt-tag">選填</span><span class="opt-done hidden" id="fbDone"></span>' +
        '<div class="opt-hint">' + codes('滿意度題目').length + ' 題，點數字即可；可把畫面交給病人或家屬自己點</div></summary>' +
      '<div class="fb-intro">依今天的感受點選分數，沒有標準答案。<br>1 分＝完全沒有，10 分＝完全做到。</div>' +
      codes('滿意度題目').map(function (c, i) {
        var k = 's' + (i + 1);
        return '<fieldset class="scale10" data-k="' + k + '"><legend><span class="qn">' + (i + 1) + '</span>' + esc(c.text) +
          '<span class="picked" aria-live="polite"></span></legend><div class="opts">' +
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(function (n) {
            return '<label class="sc' + n + '"><input type="radio" name="' + k + '" value="' + n + '" aria-label="' + n + ' 分">' + n + '</label>';
          }).join('') + '</div><div class="ends"><span>1 完全沒有</span><span>10 完全做到</span></div></fieldset>';
      }).join('') +
      '<div class="note">再點一次已選的分數可取消。</div>' +
      '<label class="f">病人簽名</label><canvas class="sig" id="sig"></canvas>' +
      '<div class="actions-bar"><button type="button" class="btn ghost small" id="sigClear">清除簽名</button></div></details>' +

      '<div class="sticky-submit"><div id="formMsg" aria-live="polite"></div><div class="actions-bar">' +
      '<button type="button" class="btn ghost" id="resetBtn">清空重填</button>' +
      '<button type="submit" class="btn" id="submitBtn">送出紀錄</button></div></div>';
    view.appendChild(f);
    draftNode = f;
    f._drugs = [];
    f._dev = {};
    bindChips(f);
    var sig = setupSignature($('#sig', f));
    $('#optFeedback', f).addEventListener('toggle', function () { if (this.open) sig.fit(); });
    f.addEventListener('input', function () { S.dirty = true; if (!f._t0) f._t0 = Date.now(); });
    f.addEventListener('change', function () { if (!f._t0) f._t0 = Date.now(); });
    f.addEventListener('change', function () { S.dirty = true; });
    f.response.addEventListener('input', function () { $('#respCount', f).textContent = f.response.value.length + ' / 5000'; });
    f.pack.addEventListener('change', function () { f.pack.dataset.auto = ''; onPackChange(f); });
    f.cat.addEventListener('change', function () { renderQuestions(f); });
    f.qsearch.addEventListener('input', function () { renderQuestions(f); });
    f.dq.addEventListener('input', function () { renderDrugSearch(f); });
    f.dq.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var first = $('#dqres [data-pick]', f); if (first) first.click(); }
    });
    $('#dqres', f).addEventListener('click', function (e) {
      var t = e.target.closest('[data-pick]');
      if (t) { addDrug(f, t.getAttribute('data-pick')); f.dq.value = ''; renderDrugSearch(f); f.dq.focus(); }
    });
    $('#drugList', f).addEventListener('click', function (e) {
      var t = e.target.closest('button');
      if (!t) return;
      if (t.getAttribute('data-rm')) removeDrug(f, t.getAttribute('data-rm'));
      if (t.getAttribute('data-card')) showCard(t.getAttribute('data-card'));
    });
    $('#lastBtn', f).addEventListener('click', function () { lookupLast(f); });
    $('#cardFill', f).addEventListener('click', function () { fillFromCards(f); });
    f.needFu.addEventListener('change', function () { $('#fuBox', f).style.display = f.needFu.checked ? '' : 'none'; updateNextCheck(f); });
    f.needRef.addEventListener('change', function () {
      $('#refBox', f).style.display = f.needRef.checked ? '' : 'none';
      if (f.needRef.checked) vals(f, 'needs').forEach(function (r) { setChecked(f, 'refRoles', r, true); });
    });
    // v2.5.2 十分量表：再點已選分數即取消；選填區顯示「已填 N 項」
    var paintScale = function (k) {
      var fs = $('fieldset[data-k="' + k + '"]', f); if (!fs) return;
      var v = radio(f, k);
      $$('input', fs).forEach(function (x) { x.parentNode.classList.toggle('on', x.checked); });
      $('.picked', fs).textContent = v ? '　' + v + ' 分' : '';
    };
    var paintOpt = function () {
      var w = vals(f, 'issues').length + vals(f, 'needs').length + (f.advice.value.trim() ? 1 : 0);
      var wd = $('#wholeDone', f); wd.textContent = '已填 ' + w + ' 項'; wd.classList.toggle('hidden', !w);
      var qs = $$('fieldset.scale10', f);
      var a = qs.filter(function (fs) { return radio(f, fs.getAttribute('data-k')); }).length;
      var fd = $('#fbDone', f); fd.textContent = '已答 ' + a + '／' + qs.length; fd.classList.toggle('hidden', !a);
    };
    $$('fieldset.scale10 label', f).forEach(function (lb) {
      lb.addEventListener('mousedown', function () { lb._was = lb.firstChild.checked; });
      lb.addEventListener('touchstart', function () { lb._was = lb.firstChild.checked; }, { passive: true });
      lb.addEventListener('click', function (e) {
        var x = lb.firstChild;
        if (e.target !== x && lb._was) { e.preventDefault(); x.checked = false; lb._was = false; paintScale(x.name); paintOpt(); S.dirty = true; }
      });
    });
    f.advice.addEventListener('input', paintOpt);
    f.addEventListener('change', function (e) {
      var n = e.target.name;
      if (n === 'coverage') e.target.dataset.touched = '1';
      if (n === 'firstTb') {
        var fv = e.target.value, need = fv === 'PART' || fv === 'NONE';
        $('#tbAfter', f).classList.toggle('hidden', !need);
        $$('input[name=teachback]', f).forEach(function (x) { x.checked = false; syncChip(x); });
      }
      if (n === 'actions' || n === 'issues' || n === 'caregiver' || n === 'source') autoCoverage(f);
      if (n && /^s\d+$/.test(n)) paintScale(n);
      if (n === 'issues' || n === 'needs' || /^s\d+$/.test(n || '')) paintOpt();
      if (n === 'qpick') onQuestionPick(f);
      if (n === 'packs2') updateAvoid(f);
      if (n === 'behaviors') {
        var any = vals(f, 'behaviors').length > 0;
        $('#ivBox', f).classList.toggle('hidden', !any);
        if (any && !f.needFu.checked) { f.needFu.checked = true; $('#fuBox', f).style.display = ''; $('#fuAuto', f).classList.remove('hidden'); updateNextCheck(f); }
      }
      if (n === 'needFu') $('#fuAuto', f).classList.add('hidden');
      if (n === 'actions' && e.target.value === 'NOACT' && e.target.checked) {
        $$('input[name="actions"]', f).forEach(function (x) { if (x.value !== 'NOACT' && x.checked) { x.checked = false; syncChip(x); } });
      } else if (n === 'actions' && e.target.checked) setChecked(f, 'actions', 'NOACT', false);
    });
    $('#sigClear', f).addEventListener('click', sig.clear);
    $('#resetBtn', f).addEventListener('click', function () {
      if (!confirm('確定清空所有欄位？')) return;
      resetDraft();
      route();
    });
    f.addEventListener('submit', function (e) { e.preventDefault(); submitRecord(f, sig); });
    f.addEventListener('change', function () { updateProgress(f); });
    f.addEventListener('input', function () { updateProgress(f); });
    // v2.5 U9：進度條可點選跳段；不當用藥行為先列 6 項；題目列與檢核表儲存格整列可點
    $$('#prog [data-step]', f).forEach(function (el) {
      var go2 = function () { var sec = $('[data-sec="' + el.getAttribute('data-step') + '"]:not(.hidden)', f); if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
      el.addEventListener('click', go2);
      el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go2(); } });
    });
    if ($('#behMore', f)) $('#behMore', f).addEventListener('click', function () { $('#behaviors', f).classList.remove('collapsed'); this.remove(); });
    $('#qlist', f).addEventListener('click', function (e) {
      if (e.target.closest('[data-qall]')) { f._qAll = true; renderQuestions(f); return; }
      var qt = e.target.closest('.qtext');
      if (qt) { var cb = $('input[name=qpick]', qt.closest('.qitem')); if (cb) cb.click(); }
    });
    $('#devList', f).addEventListener('click', function (e) {
      var td = e.target.closest('table.ck td');
      if (!td || e.target.tagName === 'INPUT') return;
      var rb = $('input[type=radio]', td); if (rb && !rb.checked) rb.click();
    });
    $('#packMulti', f).addEventListener('click', function (e) {
      var b3 = e.target.closest('[data-multipack]');
      if (!b3) return;
      var pv = b3.getAttribute('data-multipack'), x = $('input[name="packs2"][value="' + pv + '"]', f);
      if (x) { x.checked = !x.checked; syncChip(x); updateAvoid(f); }
      renderPackMulti(f); S.dirty = true;
    });
    $('#packAlt', f).addEventListener('click', function (e) {
      var b2 = e.target.closest('[data-altpack]');
      if (!b2) return;
      f.pack.value = b2.getAttribute('data-altpack'); f.pack.dataset.auto = ''; onPackChange(f); updateProgress(f); S.dirty = true;
    });
    f.source.addEventListener('change', function () { $('#srcAuto', f).classList.add('hidden'); });
    // 預先帶入
    if (pre.mrn) f.mrn.value = pre.mrn;
    var ls = lastSource();
    if (ls && $('option[value="' + ls + '"]', f.source)) { f.source.value = ls; $('#srcAuto', f).classList.remove('hidden'); }
    if (pre.fix) { f.response.value = '更正紀錄 ' + pre.fix + '：'; f.response.dataset.auto = ''; f.setAttribute('data-fix', pre.fix); }
    if (pre.last) { S.lastMrn = pre.mrn; S.last = pre.last; showLastNote(f); }
    else { S.last = {}; S.lastMrn = ''; }
    if (pre.pack && packLive(pre.pack)) { f.pack.value = pre.pack; onPackChange(f); }
    (pre.drugs || []).forEach(function (c) { addDrug(f, c); });
    if (pre.drugs && pre.drugs.length && pre.mrn) lookupLast(f, true);
    updateRequired(f);
    updateProgress(f);
    setTimeout(function () { (pre.mrn ? f.source : f.mrn).focus(); }, 0);
  }

  /** v2.4 U5：三段進度（完成打勾、缺必填顯示紅點） */
  function updateProgress(f) {
    var r = collect(f, { data: function () { return ''; } });
    var miss = localCheck(r);
    var stepOf = { mrn: 1, source: 1, pack: 2, response: 2, devices: 2, teachback: 3, actions: 3, intervention: 3, refRoles: 3 };
    var bad = { 1: 0, 2: 0, 3: 0 };
    miss.forEach(function (m) { bad[stepOf[m.field] || 3]++; });
    $$('#prog [data-step]', f).forEach(function (el) {
      var k = el.getAttribute('data-step');
      el.className = bad[k] ? 'todo' : 'done';
      el.title = bad[k] ? '尚缺 ' + bad[k] + ' 項必填' : '已完成';
      el.textContent = el.getAttribute('data-label') + (bad[k] ? ' ' + bad[k] : '');
    });
  }
  function resetDraft() { draftNode = null; S.dirty = false; S.last = {}; S.lastMrn = ''; }

  /* --- 藥品選取 --- */
  function renderDrugSearch(f) {
    var res = searchDrugs(f.dq.value, 10).filter(function (d) { return f._drugs.indexOf(d.code) < 0; });
    $('#dqres', f).innerHTML = f.dq.value.trim().length < 2 ? '' :
      (res.length ? res.map(function (d) { return drugRowHtml(d, '加入'); }).join('') : emptySearchHtml(f.dq.value.trim()));
  }
  function addDrug(f, code) {
    var d = drug(code);
    if (!d || f._drugs.indexOf(code) >= 0) return;
    if (f._drugs.length >= 20) { toast('一次最多 20 項藥品', 'err'); return; }
    f._drugs.push(code);
    S.dirty = true;
    // 主面向自動帶入：只採「已確認」之核心對照；否則用「用藥指導（自由記錄）」；使用者手選後不再覆蓋
    var conf = d.packs.filter(function (p) { return p.slice(-1) !== '?' && packLive(p); })[0];
    var autoMed = f.pack.dataset.auto === '1' && f.pack.value === 'MED';
    if (!f.pack.value || (autoMed && conf)) {
      var target = conf || (packLive('MED') ? 'MED' : '');
      if (target) { f.pack.value = target; f.pack.dataset.auto = '1'; onPackChange(f); }
    }
    renderDrugs(f);
  }
  /** v2.5 U9（D6）：多疾病藥品列出其他已確認面向，一點切換，避免成效歸錯面向 */
  function renderPackAlt(f) {
    var cur = f.pack.value, seen = {}, alt = [];
    f._drugs.forEach(function (c) {
      var d = drug(c);
      if (d) d.packs.forEach(function (p) { if (p.slice(-1) !== '?' && p !== cur && !seen[p] && packLive(p)) { seen[p] = 1; alt.push(p); } });
    });
    $('#packAlt', f).innerHTML = alt.length ? '<div class="note">此藥也常見於（點選切換主要面向）：</div><div class="chips">' + alt.slice(0, 6).map(function (p) {
      return '<button type="button" class="chip" data-altpack="' + esc(p) + '">' + esc(packName(p)) + '</button>';
    }).join('') + '</div>' : '';
  }
  /** v2.8 D9：藥品對應多個已確認核心面向時自動展開，選填本次照護面向（寫入合併面向，計入該面向人次） */
  function renderPackMulti(f) {
    var box = $('#packMulti', f); if (!box) return;
    var cur = f.pack.value, sel = vals(f, 'packs2'), rows = [];
    f._drugs.forEach(function (c) {
      var d = drug(c); if (!d || d.core.length < 2) return;
      var opts = d.core.filter(function (p) { return p !== cur && packLive(p) && S.boot.allPacks.some(function (x) { return x.code === p; }); });
      if (opts.length) rows.push('<div class="pm"><span class="note">' + esc(d.brand) + ' 對應多個疾病面向，本次也照護（選填，計入面向人次）：</span><span class="chips">' +
        opts.map(function (p) { return '<button type="button" class="chip' + (sel.indexOf(p) >= 0 ? ' on' : '') + '" data-multipack="' + esc(p) + '" aria-pressed="' + (sel.indexOf(p) >= 0) + '">' + esc(packName(p)) + '</button>'; }).join('') + '</span></div>');
    });
    box.innerHTML = rows.join('');
  }
  function removeDrug(f, code) {
    f._drugs = f._drugs.filter(function (c) { return c !== code; });
    delete f._dev[code];
    renderDrugs(f);
  }
  function renderDrugs(f) {
    var list = $('#drugList', f);
    list.innerHTML = f._drugs.length ? f._drugs.map(function (c) {
      var d = drug(c), last = S.last[c];
      return '<div class="dsel"><div class="dmain"><b>' + esc(d.brand) + '</b> <span class="note">' + esc(c) + '｜' + esc(deviceLabel(d.device)) + '</span>' +
        (last ? '<div class="lasttag ' + (last.verdict === 'PASS' ? 'ok' : last.verdict === 'FAIL' ? 'bad' : '') + '">上次教過 ' + esc(last.date) +
          (last.verdict ? '：' + esc(VERDICT_TEXT[last.verdict] || last.verdict) : '') +
          (last.failed && last.failed.length ? '；未做到：' + esc(last.failed.join('、')) : '') + '</div>' : '') + '</div>' +
        '<button type="button" class="btn small ghost" data-card="' + esc(c) + '">藥品卡</button>' +
        '<button type="button" class="btn small ghost" data-rm="' + esc(c) + '" aria-label="移除 ' + esc(d.brand) + '">移除</button></div>';
    }).join('') : '<div class="note">未選藥品時可直接依面向題目紀錄</div>';
    if (f._drugs.length >= 2) {
      var devs = {};
      f._drugs.forEach(function (c) { var d = drug(c); if (S.boot.devices[d.device]) devs[d.device] = 1; });
      if (Object.keys(devs).length) list.innerHTML += '<div class="msg info">多項裝置併用：送出後摘要會附上已簽核之「多品項使用順序」規則。</div>';
    }
    $('#cardFill', f).classList.toggle('hidden', !f._drugs.length);
    renderPackAlt(f); renderPackMulti(f);
    renderDevices(f);
    updateAvoid(f);
    updateMisuseHint(f);
    updateTeachback(f);
    updateRequired(f);
  }
  function updateTeachback(f) {
    var box = $('#tbPrompts', f);
    if (!f._drugs.length) { box.innerHTML = ''; return; }
    Promise.all(f._drugs.slice(0, 8).map(function (c) { return loadCard(c).catch(function () { return null; }); })).then(function (cards) {
      var qs = cards.filter(function (c) { return c && c.teachback; });
      box.innerHTML = qs.length ? '<div class="msg info"><b>建議回教問句</b>：請病人用自己的話回答<ul class="hint">' +
        qs.map(function (c) { return '<li>' + esc(c.brand) + '：' + esc(c.teachback) + '</li>'; }).join('') + '</ul></div>' : '';
    });
  }
  function updateAvoid(f) {
    var packs = [f.pack.value].concat(vals(f, 'packs2')).filter(String);
    var hits = [];
    f._drugs.forEach(function (c) {
      var d = drug(c);
      d.avoid.forEach(function (p) { if (packs.indexOf(p) >= 0) hits.push(d.brand + '（' + packName(p) + '）'); });
      if (S.cards[c]) (S.cards[c].packs || []).forEach(function (m) {
        if (m.role === '應避免' && packs.indexOf(m.pack) >= 0 && m.condition) hits.push('條件：' + m.condition);
      });
    });
    $('#avoidNote', f).innerHTML = hits.length ? '<div class="msg warn">面向提示：' + esc(hits.join('、')) +
      ' 屬該面向一般「應避免或需謹慎」之藥品類別。此為靜態提示，非交互作用或個別處方審查；是否需反映醫師請依臨床判斷，並可於「發現問題」登記。</div>' : '';
  }
  function updateMisuseHint(f) {
    var box = $('#misuseHint', f);
    var pm = (S.boot.packMisuse || {})[f.pack.value];
    if (!f._drugs.length && !pm) { box.innerHTML = ''; return; }
    Promise.all(f._drugs.slice(0, 6).map(function (c) { return loadCard(c).catch(function () { return null; }); })).then(function (cards) {
      var lines = [];
      if (pm) pm.lines.slice(0, 6).forEach(function (l) { lines.push([packName(f.pack.value), l, pm.draft]); });
      cards.forEach(function (c) {
        if (!c) return;
        var m = c.fields.misuse;
        if (m) m.text.split('\n').filter(String).slice(0, 4).forEach(function (l) { lines.push([c.brand, l, m.draft]); });
        if (c.deviceDetail) c.deviceDetail.misuse.slice(0, 3).forEach(function (l) { lines.push([c.brand, l, c.deviceDetail.draft]); });
      });
      box.innerHTML = lines.length ? '<details class="sub"><summary>這些藥常見的不當用藥行為（' + lines.length + '）</summary><ul class="hint">' + lines.map(function (x) {
        var p = x[1].split('｜');
        return '<li><b>' + esc(x[0]) + '</b>：' + esc(p[0]) + (p[1] ? '<div class="note">修正說法：' + esc(p[1]) + '</div>' : '') + (x[2] ? ' <span class="tag">草稿</span>' : '') + '</li>';
      }).join('') + '</ul></details>' : '';
    });
  }

  /* --- 裝置技巧評估 --- */
  function renderDevices(f) {
    var box = $('#devList', f);
    var items = f._drugs.filter(function (c) { return S.boot.devices[drug(c).device]; });
    $('#devCard', f).classList.toggle('hidden', !items.length);
    // 保留已填資料
    items.forEach(function (c) { if (!f._dev[c]) f._dev[c] = { on: true, kind: S.last[c] ? 'REVIEW' : 'FIRST', methods: ['DEMO', 'RETURN'], results: {}, errors: [], aid: 'NONE', operator: 'SELF', verdict: '' }; });
    box.innerHTML = items.map(function (c) {
      var d = drug(c), dv = S.boot.devices[d.device], st = f._dev[c];
      var nm = function (x) { return 'dv_' + c.replace(/[^A-Za-z0-9]/g, '_') + '_' + x; };
      return '<div class="dev" data-dev="' + esc(c) + '"><div class="devh"><b>' + esc(d.brand) + '</b>　' + esc(dv.name) +
        (dv.draft ? ' <span class="tag">檢核表草稿・未簽核</span>' : '') +
        '<label class="toggle inline"><input type="checkbox" data-k="on"' + (st.on ? ' checked' : '') + '>本次評估</label>' +
        '<span class="verdict" data-v></span></div>' +
        '<div class="devb' + (st.on ? '' : ' hidden') + '">' +
        '<div class="chips">' + codes('指導性質').map(function (k) { return chip(nm('kind'), k.code, k.text, st.kind === k.code, 'radio', ' data-k="kind"'); }).join('') + '</div>' +
        '<div class="chips">' + codes('指導方式').map(function (k) { return chip(nm('m'), k.code, k.text, st.methods.indexOf(k.code) >= 0, 'checkbox', ' data-k="methods"'); }).join('') + '</div>' +
        '<table class="ck"><thead><tr><th>觀察項目</th><th>做到</th><th>沒做到</th><th>未評估</th></tr></thead><tbody>' +
        dv.checklist.map(function (k) {
          var v = st.results[k.id] || 'U';
          return '<tr><td>' + (k.critical ? '<b class="crit">關鍵</b> ' : '') + esc(k.text) + '</td>' + ['Y', 'N', 'U'].map(function (x) {
            return '<td><input type="radio" aria-label="' + esc(k.text) + ' ' + { Y: '做到', N: '沒做到', U: '未評估' }[x] + '" name="' + nm(k.id) + '" value="' + x + '" data-k="ck" data-id="' + esc(k.id) + '"' + (v === x ? ' checked' : '') + '></td>';
          }).join('') + '</tr>';
        }).join('') + '</tbody></table>' +
        '<div class="actions-bar left"><button type="button" class="btn small ghost" data-allY>全部做到</button></div>' +
        (dv.errors.length ? '<details class="sub"><summary>觀察到的常見錯誤</summary><div class="chips">' + dv.errors.map(function (e) {
          return chip(nm('e'), e.code, e.text, st.errors.indexOf(e.code) >= 0, 'checkbox', ' data-k="errors"');
        }).join('') + '</div></details>' : '') +
        '<div class="row two"><div><label class="f">輔具</label><div class="chips">' + codes('輔具').map(function (k) { return chip(nm('aid'), k.code, k.text, st.aid === k.code, 'radio', ' data-k="aid"'); }).join('') + '</div></div>' +
        '<div><label class="f">操作者</label><div class="chips">' + codes('操作者').map(function (k) { return chip(nm('op'), k.code, k.text, st.operator === k.code, 'radio', ' data-k="operator"'); }).join('') + '</div></div></div>' +
        '<label class="f">判定（自動計算，只能下修）</label><select data-k="down"><option value="">依檢核結果</option><option value="PARTIAL">下修為部分通過</option><option value="FAIL">下修為未通過</option></select>' +
        '</div></div>';
    }).join('');
    $$('.dev', box).forEach(function (el) {
      var c = el.getAttribute('data-dev'), st = f._dev[c];
      $('[data-k=down]', el).value = st.verdict;
      el.addEventListener('change', function (e) {
        var k = e.target.getAttribute('data-k');
        if (!k) return;
        if (k === 'on') { st.on = e.target.checked; $('.devb', el).classList.toggle('hidden', !st.on); }
        if (k === 'kind') st.kind = e.target.value;
        if (k === 'methods') st.methods = $$('[data-k=methods]:checked', el).map(function (x) { return x.value; });
        if (k === 'errors') st.errors = $$('[data-k=errors]:checked', el).map(function (x) { return x.value; });
        if (k === 'aid') st.aid = e.target.value;
        if (k === 'operator') st.operator = e.target.value;
        if (k === 'ck') st.results[e.target.getAttribute('data-id')] = e.target.value;
        if (k === 'down') st.verdict = e.target.value;
        showVerdict(f, c, el);
        updateRequired(f);
      });
      $('[data-allY]', el).addEventListener('click', function () {
        $$('input[data-k=ck][value=Y]', el).forEach(function (x) { x.checked = true; st.results[x.getAttribute('data-id')] = 'Y'; });
        S.dirty = true;
        showVerdict(f, c, el);
        updateRequired(f);
      });
      showVerdict(f, c, el);
    });
  }
  function calcVerdict(dv, st) {
    var anyN = false, critN = false, allU = true, critAllY = true;
    dv.checklist.forEach(function (k) {
      var v = st.results[k.id] || 'U';
      if (v !== 'U') allU = false;
      if (v === 'N') { anyN = true; if (k.critical) critN = true; }
      if (k.critical && v !== 'Y') critAllY = false;
    });
    var v = allU ? 'NA' : critN ? 'FAIL' : (!anyN && critAllY ? 'PASS' : 'PARTIAL');
    var rank = { PASS: 3, PARTIAL: 2, FAIL: 1 };
    if (st.verdict && rank[st.verdict] && rank[v] && rank[st.verdict] < rank[v]) v = st.verdict;
    return v;
  }
  function showVerdict(f, c, el) {
    var st = f._dev[c], dv = S.boot.devices[drug(c).device];
    var v = calcVerdict(dv, st);
    var badge = $('[data-v]', el);
    badge.className = 'verdict tag ' + (VERDICT_TAG[v] || '');
    badge.textContent = st.on ? VERDICT_TEXT[v] : '不評估';
  }
  function activeDevices(f) {
    return f._drugs.filter(function (c) { return f._dev[c] && f._dev[c].on && S.boot.devices[drug(c).device]; });
  }
  function updateRequired(f) {
    var hasDev = activeDevices(f).length > 0, hasDrug = f._drugs.length > 0;
    $('#tbReq', f).classList.toggle('hidden', hasDev);
    $('#tbHint', f).textContent = hasDev ? '（未選時依技巧評估最差結果自動帶入）' : '';
    $('#respReq', f).classList.toggle('hidden', hasDrug);
    $('#respHint', f).textContent = hasDrug ? '（空白時系統記錄「已依藥品卡說明」）' : '（勾選題目會自動帶入，可修改）';
  }

  /* --- 上次指導 --- */
  function lookupLast(f, quiet) {
    var mrn = f.mrn.value.trim();
    if (!MRN_RE.test(mrn)) { if (!quiet) toast('請先輸入正確病歷號', 'err'); return; }
    $('#lastNote', f).innerHTML = '<div class="note">查詢中…</div>';
    api('history', { mrn: mrn }).then(function (h) {
      S.last = h.lastByDrug || {}; S.lastMrn = mrn;
      showLastNote(f, h);
      Object.keys(S.last).forEach(function (c) { if (f._dev[c] && f._dev[c].kind === 'FIRST') f._dev[c].kind = 'REVIEW'; });
      renderDrugs(f);
    }).catch(function (e) { $('#lastNote', f).innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }
  function showLastNote(f, h) {
    var keys = Object.keys(S.last);
    var box = $('#lastNote', f);
    if (!keys.length) { box.innerHTML = '<div class="note">' + (h && h.shown ? '過去 ' + h.shown + ' 筆紀錄，無裝置評估' : '無可檢視之過去紀錄') + '</div>'; return; }
    box.innerHTML = '<div class="note">過去指導過：</div><div class="chips">' + keys.map(function (c) {
      var x = S.last[c];
      return '<button type="button" class="chip" data-lastadd="' + esc(c) + '">' + esc(x.brand) + ' <span class="tag ' + (VERDICT_TAG[x.verdict] || '') + '">' + esc(VERDICT_TEXT[x.verdict] || '') + '</span></button>';
    }).join('') + '</div>';
    $$('[data-lastadd]', box).forEach(function (bt) { bt.addEventListener('click', function () { addDrug(f, bt.getAttribute('data-lastadd')); }); });
  }

  /* --- 回應帶入 --- */
  function fillFromCards(f) {
    Promise.all(f._drugs.map(function (c) { return loadCard(c).catch(function () { return null; }); })).then(function (cards) {
      var parts = cards.filter(Boolean).map(function (c) {
        var x = c.fields, lines = ['【' + c.brand + '】'];
        [['how', '怎麼用'], ['missed', '忘記用'], ['seek', '何時就醫']].forEach(function (k) { if (x[k[0]]) lines.push(k[1] + '：' + x[k[0]].text); });
        if (lines.length === 1) lines.push('依藥袋或醫師指示使用。');
        return lines.join('\n');
      });
      var text = parts.join('\n\n').slice(0, 5000);
      if (f.response.value && f.response.dataset.auto !== f.response.value && !confirm('以藥品卡重點覆蓋目前內容？')) return;
      f.response.value = text;
      f.response.dataset.auto = text;
      $('#respCount', f).textContent = text.length + ' / 5000';
      if (cards.some(function (c) { return c && Object.keys(c.fields).some(function (k) { return c.fields[k].draft; }); })) toast('含未簽核草稿內容，請核對後再說明', 'err');
    });
  }

  /* --- 面向與題目 --- */
  function isLearner() { var l = (S.boot.user || {}).learner; return l === 'PGY' || l === 'UGY'; }
  function isUgy() { return (S.boot.user || {}).learner === 'UGY'; }
  /** v2.7 本次涵蓋：依面向列出（共通＋本面向專屬），保留已勾選 */
  function renderCoverage(f) {
    var box = $('#covBox', f); if (!box) return;
    var keep = vals(f, 'coverage'), pk = f.pack.value;
    var list = codes('本次涵蓋').filter(function (c) { return c.pack === 'ALL' || c.pack === pk; });
    box.innerHTML = list.map(function (c) { return chip('coverage', c.code, c.text, keep.indexOf(c.code) >= 0); }).join('');
    $('#covWrap', f).classList.toggle('hidden', !list.length);
  }
  /** 預勾：未手動改過才自動勾（MEDREV←交互作用盤點；DCREC←出院前；NEED←全人評估有勾問題或照顧者在場） */
  function autoCoverage(f) {
    var set = function (code, on) {
      var x = $('input[name=coverage][value="' + code + '"]', f); if (!x || x.dataset.touched) return;
      if (x.checked !== on) { x.checked = on; syncChip(x); }
    };
    var acts = vals(f, 'actions');
    var ddi = codes('行動計畫').some(function (c) { return acts.indexOf(c.code) >= 0 && /(^|;)U-DDI/.test(c.group || ''); });
    set('MEDREV', ddi);
    set('DCREC', f.source.value === 'DC');
    set('NEED', vals(f, 'issues').length > 0 || f.caregiver.checked);
  }
  function supVisible() { var lv = { L1: 1, L2: 2, L3: 3, L4: 4 }[S.boot.user.level] || 1; return lv <= (S.boot.settings.supLevel || 1); }
  function updateNextCheck(f) {
    var el = $('#nextCheck', f); if (!el) return;
    var outs = codes('結果項目').filter(function (c) { return c.pack === f.pack.value && !/反向/.test(c.group || ''); }).slice(0, 4);
    el.classList.toggle('hidden', !(f.needFu.checked && outs.length));
    el.innerHTML = '<b>追蹤時會確認：</b>' + outs.map(function (c) { return esc(c.text); }).join('；') + '（同時印在病人版摘要）';
  }

  function onPackChange(f) {
    var code = f.pack.value;
    var p = S.boot.packs.filter(function (x) { return x.code === code; })[0];
    f._qAll = false;
    renderPackAlt(f); renderPackMulti(f);
    $('#packNote', f).innerHTML = (f.pack.dataset.auto === '1' ? '<div class="note"><span class="auto">自動</span> 依藥品帶入，可修改</div>' : '') +
      (p && p.status === '過渡沿用' ? '<div class="msg info">此面向沿用舊版題庫，內容尚未完成來源複審；回應請依現行指引自行確認。</div>' : '');
    var keep = vals(f, 'packs2');
    $('#packs2', f).innerHTML = S.boot.allPacks.filter(function (x) { return x.code !== code; })
      .map(function (x) { return chip('packs2', x.code, x.name, keep.indexOf(x.code) >= 0); }).join('');
    var keepA = vals(f, 'actions');
    var acts = codes('行動計畫').filter(function (c) { return c.pack === code || c.pack === 'ALL'; });
    // v2.6：帶通用標籤者（不自行停藥、警訊、自我監測、交互作用…）排第一列，固定位置；其餘為本面向專屬
    var isU = function (c) { return /(^|;)U-/.test(c.group || ''); };
    var row = function (list) { return list.map(function (c) { return chip('actions', c.code, c.text, keepA.indexOf(c.code) >= 0); }).join(''); };
    var uA = acts.filter(function (c) { return isU(c) && c.code !== 'NOACT'; }), oA = acts.filter(function (c) { return !isU(c); });
    $('#actions', f).innerHTML = acts.length ? (uA.length ? '<div class="group-label">核心（跨面向共同指標）</div><div class="chips">' + row(uA) + '</div><div class="group-label">本面向</div>' : '') +
      '<div class="chips">' + row(oA) + '</div>' : '<span class="note">無選項</span>';
    renderCoverage(f); autoCoverage(f);
    var kv = (S.boot.settings.kv || {})[code];
    $('#kvBox', f).classList.toggle('hidden', !kv);
    if (kv) {
      $('#kvLabel', f).textContent = kv.label + '（' + kv.min + '–' + kv.max + ' ' + kv.unit + '）';
      f.keyValue.min = kv.min; f.keyValue.max = kv.max; f.keyValue.step = kv.step; $('#kvUnit', f).textContent = kv.unit;
    } else f.keyValue.value = '';
    updateNextCheck(f);
    if (p) {
      f.fuDays.value = p.fuDays || 14;
      if (p.fuRole) f.fuRole.value = p.fuRole;
    }
    updateAvoid(f);
    updateMisuseHint(f);
    if (!code) { $('#qlist', f).innerHTML = '<div class="empty">請先選擇主要照護面向</div>'; return; }
    $('#qlist', f).innerHTML = '<div class="empty">載入題目中…</div>';
    loadQuestions(code).then(function (qs) {
      if (f.pack.value !== code) return;
      var cats = {};
      qs.forEach(function (q) { cats[q.cat === 'QX' ? 'QX:' + (q.legacyCat || '其他') : q.cat] = true; });
      f.cat.innerHTML = '<option value="">全部</option>' + Object.keys(cats).sort().map(function (k) {
        var label = k.indexOf('QX:') === 0 ? k.slice(3) : codeText('問題分類', k);
        return '<option value="' + esc(k) + '">' + esc(label) + '</option>';
      }).join('');
      renderQuestions(f);
    }).catch(function (e) { $('#qlist', f).innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  function loadQuestions(code) {
    if (S.qcache[code]) return Promise.resolve(S.qcache[code]);
    return api('questions', { pack: code }).then(function (qs) { S.qcache[code] = qs; return qs; });
  }

  function renderQuestions(f) {
    var code = f.pack.value;
    var qs = S.qcache[code] || [];
    var cat = f.cat.value, kw = f.qsearch.value.trim().toLowerCase();
    var picked = vals(f, 'qpick');
    var list = qs.filter(function (q) {
      var k = q.cat === 'QX' ? 'QX:' + (q.legacyCat || '其他') : q.cat;
      if (cat && k !== cat && picked.indexOf(q.id) < 0) return false;
      if (kw && (q.q + ' ' + q.a).toLowerCase().indexOf(kw) < 0 && picked.indexOf(q.id) < 0) return false;
      return true;
    });
    // v2.5 U9：未篩選時先列 5 題（已勾選者永遠列出），其餘按「顯示全部」
    var total = list.length, limited = !cat && !kw && !f._qAll && list.length > 5;
    if (limited) { var shown = 0; list = list.filter(function (q) { if (picked.indexOf(q.id) >= 0) return true; shown++; return shown <= 5; }); }
    $('#qlist', f).innerHTML = list.length ? list.map(function (q) {
      return '<div class="qitem"><input type="checkbox" name="qpick" value="' + esc(q.id) + '"' + (picked.indexOf(q.id) >= 0 ? ' checked' : '') +
        ' aria-label="選擇題目"><div class="q"><div class="qtext">' + esc(q.q) + '</div><div class="meta">' +
        (q.tags.indexOf('REDFLAG') >= 0 ? ' <span class="tag bad">紅旗</span>' : '') +
        (q.att ? ' <button type="button" class="btn ghost small" data-att="' + esc(q.id) + '">附件</button>' : '') +
        '</div><details><summary>預覽回應</summary><div>' + esc(q.a) + '</div><div class="note">題目編號 ' + esc(q.id) + '</div>' +
        (q.staff ? '<div class="qstaff"><b>人員提示（不給病人）</b>\n' + esc(q.staff) + '</div>' : '') + '</details></div></div>';
    }).join('') + (limited ? '<div class="qmore"><button type="button" class="btn small ghost" data-qall>顯示全部 ' + total + ' 題</button></div>' : '') :
      '<div class="empty">' + (qs.length ? '沒有符合的題目' : '此面向為自由記錄，請直接填寫回應') + '</div>';
    $$('[data-att]', f).forEach(function (btn) { btn.addEventListener('click', function () { showAttachment(btn.getAttribute('data-att')); }); });
  }

  function onQuestionPick(f) {
    var qs = S.qcache[f.pack.value] || [];
    var picked = vals(f, 'qpick');
    var text = qs.filter(function (q) { return picked.indexOf(q.id) >= 0; }).map(function (q) { return '【' + q.q + '】\n' + q.a; }).join('\n\n');
    if (f.response.value && f.response.dataset.auto !== f.response.value && !confirm('以勾選題目的標準回應覆蓋目前內容？')) return;
    f.response.value = text.slice(0, 5000);
    f.response.dataset.auto = f.response.value;
    // v2.6：勾了紅旗題目 → 預勾本面向「警訊」行動計畫（可取消）
    if (qs.some(function (q) { return picked.indexOf(q.id) >= 0 && q.tags.indexOf('REDFLAG') >= 0; })) {
      var rf = codes('行動計畫').filter(function (c) { return c.pack === f.pack.value && /(^|;)U-REDFLAG/.test(c.group || ''); })[0];
      if (rf && !vals(f, 'actions').length) { setChecked(f, 'actions', rf.code, true); setChecked(f, 'actions', 'NOACT', false); }
    }
    $('#respCount', f).textContent = f.response.value.length + ' / 5000';
  }

  function showAttachment(qid) {
    var m = modal('<div class="empty">載入附件中…</div>');
    api('attachment', { qid: qid, n: 1 }).then(function (a) {
      if (a.link) m.body.innerHTML = '<a href="' + esc(a.link) + '" target="_blank" rel="noopener">開啟附件</a>';
      else if (/^image\//.test(a.mime)) m.body.innerHTML = '<img alt="' + esc(a.name) + '" src="data:' + esc(a.mime) + ';base64,' + a.data + '">';
      else m.body.innerHTML = '<a download="' + esc(a.name) + '" href="data:' + esc(a.mime) + ';base64,' + a.data + '">下載 ' + esc(a.name) + '</a>';
    }).catch(function (e) { m.body.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  function setupSignature(cv) {
    var ctx = cv.getContext('2d'), drawing = false, used = false;
    var fit = function () {
      var r = cv.getBoundingClientRect();
      if (!r.width) return;
      var dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(r.width, 300) * dpr;
      cv.height = 160 * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2.2; ctx.lineCap = 'round'; ctx.strokeStyle = '#1f2a37';
      used = false;
    };
    setTimeout(fit, 0);
    var pos = function (e) { var r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', function (e) { drawing = true; used = true; var p = pos(e); ctx.beginPath(); ctx.moveTo(p[0], p[1]); cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', function (e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p[0], p[1]); ctx.stroke(); });
    cv.addEventListener('pointerup', function () { drawing = false; });
    return {
      fit: fit,
      clear: function () { ctx.clearRect(0, 0, cv.width, cv.height); used = false; },
      data: function () {
        if (!used) return '';
        var out = document.createElement('canvas');
        out.width = 600; out.height = Math.round(600 * cv.height / cv.width);
        var o = out.getContext('2d'); o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height);
        o.drawImage(cv, 0, 0, out.width, out.height);
        return out.toDataURL('image/jpeg', 0.8);
      }
    };
  }

  function collect(f, sig) {
    var resp = f.response.value.trim();
    var auto = f.response.dataset.auto;
    return {
      mrn: f.mrn.value.trim(), source: f.source.value, branch: f.branch ? f.branch.value : '', pack: f.pack.value,
      packs2: vals(f, 'packs2'), cat: f.cat.value.indexOf('QX:') === 0 ? 'QX' : f.cat.value, qids: vals(f, 'qpick'),
      question: f.question.value.trim(), response: resp, issues: vals(f, 'issues'), needs: vals(f, 'needs'),
      advice: f.advice.value.trim(), firstTeachback: radio(f, 'firstTb'),
      teachback: (function () { var t1 = radio(f, 'firstTb'); return t1 === 'FULL' || t1 === 'NA' ? t1 : radio(f, 'teachback'); })(),
      coverage: vals(f, 'coverage'), supervisor: f.supervisor ? f.supervisor.value : '',
      actions: vals(f, 'actions'), caregiver: f.caregiver.checked,
      needFu: f.needFu.checked, fuDays: f.fuDays.value, fuRole: f.fuRole.value, needRef: f.needRef.checked,
      refRoles: vals(f, 'refRoles'), s1: radio(f, 's1'), s2: radio(f, 's2'), s3: radio(f, 's3'), satScale: 'V3_1-10', signature: sig.data(),
      drugs: f._drugs.slice(),
      devices: activeDevices(f).map(function (c) {
        var st = f._dev[c];
        return { drug: c, kind: st.kind, methods: st.methods, results: st.results, errors: st.errors, aid: st.aid, operator: st.operator, verdict: st.verdict };
      }),
      behaviors: vals(f, 'behaviors'), intervention: radio(f, 'intervention'),
      entry: f.getAttribute('data-entry') || '面向',
      autoEdited: auto ? auto.trim() !== resp : undefined,
      supervision: radio(f, 'supervision'), keyValue: f.keyValue ? f.keyValue.value.trim() : '',
      fillSec: f._t0 ? Math.round((Date.now() - f._t0) / 1000) : ''
    };
  }

  /** 回傳 [{field, text}]；field 對應表單 data-field，用於內嵌錯誤與進度條 */
  function localCheck(r) {
    var e = [];
    var add = function (field, text) { e.push({ field: field, text: text }); };
    if (!MRN_RE.test(r.mrn)) add('mrn', '病歷號（4–20 位英數字）');
    if (!r.source) add('source', '病人來源');
    if (!r.pack) add('pack', '主要照護面向');
    if (!r.response && !r.drugs.length) add('response', '醫療人員回應（或選擇藥品）');
    if (!r.firstTeachback && !r.devices.length) add('teachback', '第一次教回結果');
    if ((r.firstTeachback === 'PART' || r.firstTeachback === 'NONE') && !r.teachback) add('teachback', '重新說明後的教回結果');
    if (isUgy() && r.supervision !== 'PRES' && r.supervision !== 'REV') add('supervision', '督導方式（教師在場或事後覆核）');
    if ((isUgy() || r.supervision === 'REV') && !r.supervisor) add('supervisor', '督導教師');
    if (!r.actions.length) add('actions', '行動計畫');
    if (r.behaviors.length && !r.intervention) add('intervention', '介入結果');
    if (r.needRef && !r.refRoles.length) add('refRoles', '轉介職類');
    r.devices.forEach(function (d) { if (!d.methods.length) add('devices', drug(d.drug).brand + ' 指導方式'); });
    return e;
  }
  function showFieldErrors(f, miss) {
    $$('.ferr', f).forEach(function (x) { x.remove(); });
    $$('.haserr', f).forEach(function (x) { x.classList.remove('haserr'); });
    var first = null;
    miss.forEach(function (m) {
      var box = m.field === 'devices' ? $('#devCard', f) : $('[data-field="' + m.field + '"]', f);
      if (!box) return;
      box.classList.add('haserr');
      var d = document.createElement('div');
      d.className = 'ferr'; d.textContent = '請填寫：' + m.text;
      box.appendChild(d);
      if (!first) first = box;
    });
    if (first) { first.scrollIntoView({ behavior: 'smooth', block: 'center' }); var inp = $('input,select,textarea', first); if (inp) inp.focus({ preventScroll: true }); }
  }

  function submitRecord(f, sig) {
    var r = collect(f, sig);
    var miss = localCheck(r);
    var msg = $('#formMsg', f);
    showFieldErrors(f, miss);
    if (miss.length) { msg.innerHTML = '<div class="msg err">尚有 ' + miss.length + ' 項必填：' + esc(miss.map(function (m) { return m.text; }).join('、')) + '</div>'; return; }
    if (S.lastMrn && S.lastMrn !== r.mrn) { S.last = {}; } // 換病人時不沿用上次資料
    var btn = $('#submitBtn', f);
    btn.textContent = '寫入中…';
    // v2.4 U5：送出狀態條＋鎖定整張表單，伺服器回傳紀錄編號才解鎖
    var t0 = Date.now();
    f.classList.add('locked');
    var ctrls = $$('input,select,textarea,button', f).filter(function (x) { return !x.disabled; });
    ctrls.forEach(function (x) { x.disabled = true; });
    // v2.5 U11：寫入等待期間先列出本次行動計畫，藥師可先向病人說明；超過 10 秒提示網路較慢
    var actTexts = $$('input[name=actions]:checked', f).filter(function (x) { return x.value !== 'NOACT'; }).map(function (x) { return x.parentNode.textContent.trim(); });
    var preview = actTexts.length ? '<div class="msg ok preview"><b>可先向病人說明的行動計畫</b>（正式摘要存檔後產生）<ul>' + actTexts.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>' : '';
    var tick = function () {
      var sec = Math.round((Date.now() - t0) / 1000);
      msg.innerHTML = '<div class="msg info submitting">已送出，寫入中（' + sec + ' 秒）…請勿關閉或重按' + (sec >= 10 ? '。網路較慢，仍在處理' : '') + '</div>' + preview;
    };
    tick();
    var timer = setInterval(tick, 1000);
    var unlock = function () { clearInterval(timer); f.classList.remove('locked'); ctrls.forEach(function (x) { x.disabled = false; }); };
    api('submit', { record: r }).then(function (res) {
      unlock();
      lastSource(r.source);
      if (r.supervision) S.lastSup = r.supervision;
      if (r.supervisor) S.lastSupT = r.supervisor;
      resetDraft();
      var vs = (res.verdicts || []).map(function (v) { return drug(v.drug).brand + ' ' + (VERDICT_TEXT[v.verdict] || v.verdict); });
      toast('已存檔（紀錄編號 ' + res.recordId + '）' + (vs.length ? '：' + vs.join('、') : ''));
      showSummary(res.summary, res.recordId);
      go('home');
    }).catch(function (e) {
      unlock();
      msg.innerHTML = '<div class="msg err">未存檔：' + esc(e.message) + '（內容已保留，可修正後重送）</div>';
      btn.textContent = '送出紀錄';
    });
  }

  /* ---------- 病人版摘要 ---------- */
  function summaryHtml(s) {
    var drugs = (s.drugs || []).map(function (d) {
      return '<div class="sdrug"><h4>' + esc(d.brand) + '</h4>' +
        (d.steps && d.steps.length ? '<ol>' + d.steps.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>' : '') +
        (d.diff ? '<p>' + esc(d.diff) + '</p>' : '') +
        (d.how ? '<p><b>怎麼用：</b>' + esc(d.how) + '</p>' : '') +
        (d.store ? '<p><b>保存：</b>' + esc(d.store) + '</p>' : '') +
        (d.redflags && d.redflags.length ? '<div class="red">' + d.redflags.map(esc).join('\n') + '</div>' : '') + '</div>';
    }).join('');
    return '<div id="summary"><div class="sum-title">' + esc(s.hospital) + '　用藥與照護重點</div>' +
      '<div class="note">' + esc(s.date) + '｜' + esc(s.packName) + '｜' + esc(s.roleText) + '說明</div>' +
      (drugs ? '<h3>今天說明的藥品</h3>' + drugs : '') +
      (s.multiRules && s.multiRules.length ? '<h3>多種吸入或外用藥一起用時</h3><ul>' + s.multiRules.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
      (s.answers && s.answers.length ? '<h3>今天說明的內容</h3>' + s.answers.map(function (x) { return '<div class="sqa"><b>' + esc(x.q) + '</b><div class="pre">' + esc(x.a) + '</div></div>'; }).join('') :
        (s.topics.length ? '<h3>今天說明的內容</h3><ul>' + s.topics.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '')) +
      (s.response ? '<h3>' + (s.answers && s.answers.length ? '補充說明' : (s.topics.length ? '說明' : '今天說明的內容')) + '</h3><div class="pre">' + esc(s.response) + '</div>' : '') +
      (s.actions.length ? '<h3>回家後我要做的事</h3><ul>' + s.actions.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '') +
      (s.redflags ? '<h3>出現以下情況請立即就醫</h3><div class="red">' + esc(s.redflags) + '</div>' : '') +
      (s.fuDue ? '<h3>下次追蹤</h3><p>我們將在 ' + esc(s.fuDue) + ' 前後與您聯繫或於回診時確認' +
        (s.nextCheck && s.nextCheck.length ? '以下事項：</p><ul>' + s.nextCheck.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>' : '。</p>') : '') +
      '<p class="note">藥品劑量與次數請依藥袋或醫師指示。本摘要不含病歷號碼；如有疑問請洽原診療團隊或藥局。</p></div>';
  }
  function showSummary(s, recId) {
    var m = modal(summaryHtml(s) + '<p class="note no-print">發現錯誤？紀錄不可刪除（雜湊鏈保護），請在「病人歷史」為此病人新增一筆更正紀錄並於回應註明' + (recId ? '更正 ' + esc(recId) : '更正原紀錄編號') + '。</p>');
    var bar = $('.actions-bar', m.box);
    var p = document.createElement('button');
    p.type = 'button'; p.className = 'btn'; p.textContent = '列印病人版摘要';
    p.addEventListener('click', function () { $('#printArea').innerHTML = summaryHtml(s); window.print(); });
    bar.insertBefore(p, bar.firstChild);
  }

  /* ---------- 我的待辦 ---------- */
  function setTaskBadge(t) {
    var n = t.followups.filter(function (f) { return f.overdue || f.due <= today(); }).length + t.referrals.length + ((t.reviews || {}).mine || []).length;
    var b = $('#taskBadge');
    if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
  }
  function refreshTaskBadge() {
    api('tasks').then(function (t) { S.tasks = t; setTaskBadge(t); }).catch(function () {});
  }

  function viewTasks(view) {
    view.innerHTML = '<div class="card"><h2>我的待辦</h2><div class="sk"><div class="skel"></div><div class="skel"></div></div></div>';
    vapi('tasks').then(function (t) {
      S.tasks = t; setTaskBadge(t);
      var ctxHtml = function (c) {
        c = c || {};
        var rows = [];
        if (c.date) rows.push('上次紀錄 ' + c.date);
        if (c.drugs && c.drugs.length) rows.push('藥品：' + c.drugs.join('、'));
        if (c.behaviors && c.behaviors.length) rows.push('發現：' + c.behaviors.join('、') + (c.intervention ? ' → 介入：' + c.intervention : ''));
        if (c.teachback) rows.push('教回：' + c.teachback);
        return rows.length ? '<div class="ctx note">' + rows.map(esc).join('<br>') + '</div>' : '';
      };
      var resOpts = codes('追蹤結果').map(function (c) { return '<option value="' + esc(c.code) + '">' + esc(c.text) + '</option>'; }).join('');
      var refOpts = codes('轉介結果').map(function (c) { return '<option value="' + esc(c.code) + '">' + esc(c.text) + '</option>'; }).join('');
      // v2.5 U8：依到期分組；每筆一行摘要，點開才展開表單；完成後原地收合，不重載整頁
      var td = today(), wk = ymdAdd(td, 7);
      var grp = function (f) { return (f.overdue || f.due < td) ? 'over' : f.due === td ? 'today' : f.due <= wk ? 'week' : 'later'; };
      var G = [['over', '逾期'], ['today', '今天到期'], ['week', '7 天內到期'], ['later', '之後到期']];
      var total = t.followups.length + t.referrals.length, openAll = total <= 3;
      var fus = t.followups.slice().sort(function (x, y) { return x.due < y.due ? -1 : x.due > y.due ? 1 : 0; });
      var fuItem = function (f) {
        return '<details class="task"' + (openAll ? ' open' : '') + '><summary><b>' + esc(f.packName) + '</b>　末四碼 ' + esc(f.last4) +
          '　<span class="' + (grp(f) === 'over' ? 'overdue' : '') + '">到期 ' + esc(f.due) + (grp(f) === 'over' ? '（逾期）' : '') + '</span>' +
          (f.mine ? ' <span class="tag ok">我建立</span>' : ' <span class="tag">' + esc(f.role) + '</span>') + (f.hasBehaviors ? ' <span class="tag bad">需確認行為</span>' : '') + '</summary>' +
          '<form data-fu="' + esc(f.id) + '" data-beh="' + (f.hasBehaviors ? '1' : '') + '" data-label="' + esc(f.packName + ' 末四碼 ' + f.last4) + '">' + ctxHtml(f.ctx) +
          '<div class="row two"><div><label class="f">追蹤結果</label><select name="result"><option value="">請選擇</option>' + resOpts + '</select></div>' +
          '<div><label class="f">說明</label><input type="text" name="note" maxlength="1000"></div></div>' +
          (f.hasBehaviors ? '<label class="f">上次發現的不當用藥行為是否仍持續？ <span class="req">*</span></label><div class="chips">' +
            chip('persist', 'N', '已改善', false, 'radio') + chip('persist', 'Y', '仍持續', false, 'radio') + '</div>' : '') +
          (f.outcomes.length ? '<label class="f">結果項目 <span class="note">每項點「是／否」；沒問到的保持「未問」，不計入統計</span></label><div class="outs">' +
            f.outcomes.map(function (o) {
              var n = 'o_' + o.code;
              return '<div class="orow' + (o.reverse ? ' rev' : '') + '" role="radiogroup" aria-label="' + esc(o.text) + '"><span class="otext">' + esc(o.text) +
                (o.reverse ? ' <span class="tag bad">不良事件</span>' : '') + '</span><span class="seg3">' +
                chip(n, 'Y', '是', false, 'radio') + chip(n, 'N', '否', false, 'radio') + chip(n, '', '未問', true, 'radio') + '</span></div>';
            }).join('') + '</div>' : '') +
          (f.kv ? '<label class="f">' + esc(f.kv.label) + '（' + f.kv.min + '–' + f.kv.max + ' ' + esc(f.kv.unit) + '，選填）</label><input type="number" name="keyValue" class="kv" min="' + f.kv.min + '" max="' + f.kv.max + '" step="' + f.kv.step + '" inputmode="decimal">' : '') +
          '<div class="actions-bar"><button type="button" class="btn small ghost" data-redo="' + esc(f.pack) + '">再次指導</button><button class="btn small">完成追蹤</button></div></form></details>';
      };
      var fuHtml = G.map(function (g) {
        var items = fus.filter(function (f) { return grp(f) === g[0]; });
        return items.length ? '<div class="tgroup ' + g[0] + '"><h3>' + g[1] + '（<span data-gn>' + items.length + '</span>）</h3>' + items.map(fuItem).join('') + '</div>' : '';
      }).join('');
      var refs = t.referrals.slice().sort(function (x, y) { return y.days - x.days; });
      var refHtml = refs.map(function (x) {
        return '<details class="task"' + (openAll ? ' open' : '') + '><summary><b>' + esc(x.packName) + '</b>　末四碼 ' + esc(x.last4) +
          '　發出 ' + esc(x.sent) + '（第 ' + esc(x.days) + ' 天）' + (x.days > 7 ? ' <span class="tag bad">超過 7 天</span>' : '') + '</summary>' +
          '<form data-ref="' + esc(x.id) + '" data-label="' + esc(x.packName + ' 末四碼 ' + x.last4) + '">' + ctxHtml(x.ctx) +
          '<div class="row two"><div><label class="f">處理結果</label><select name="result"><option value="">請選擇</option>' + refOpts + '</select></div>' +
          '<div><label class="f">說明</label><input type="text" name="note" maxlength="1000"></div></div>' +
          '<div class="actions-bar"><button class="btn small">完成轉介</button></div></form></details>';
      }).join('');
      view.innerHTML =
        '<div class="card" id="fuCard"><h2>追蹤（<span id="fuN">' + t.followups.length + '</span>）</h2>' + (t.followups.length ? fuHtml : '<div class="empty">沒有待辦追蹤</div>') + '</div>' +
        '<div class="card" id="refCard"><h2>轉介給我的職類（<span id="refN">' + t.referrals.length + '</span>）</h2>' + (t.referrals.length ? refHtml : '<div class="empty">沒有待受理轉介</div>') + '</div>' +
        reviewHtml(t.reviews || {}, ctxHtml);
      bindChips(view);
      $$('form[data-rv]', view).forEach(function (f) {
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          var res = radio(f, 'rvres');
          if (!res) return toast('請選擇覆核結果', 'err');
          if (res === '需修正' && !f.fb.value.trim()) { f.fb.focus(); return toast('需修正時請寫回饋', 'err'); }
          var btn = f.querySelector('button'); btn.disabled = true; btn.textContent = '寫入中…';
          api('review', { id: f.getAttribute('data-rv'), result: res, feedback: f.fb.value.trim() }).then(function () {
            var d = f.closest('details.task'), ok = document.createElement('div');
            ok.className = 'task done'; ok.setAttribute('role', 'status'); ok.textContent = '✓ 已覆核：' + f.getAttribute('data-label') + '（' + res + '）';
            d.parentNode.replaceChild(ok, d);
            var n = $('#rvN'); if (n) n.textContent = Math.max(0, +n.textContent - 1);
          }).catch(function (er) { toast(er.message, 'err'); btn.disabled = false; btn.textContent = '送出覆核'; });
        });
      });
      $$('[data-redo]', view).forEach(function (bt) {
        bt.addEventListener('click', function () { var p = bt.getAttribute('data-redo'); startRecord({ pack: packLive(p) ? p : '', entry: '待辦' }); });
      });
      var done = function (f, kind) {
        var id = f.getAttribute(kind === 'fu' ? 'data-fu' : 'data-ref');
        var d = f.closest('details.task'), g = d.closest('.tgroup');
        var ok = document.createElement('div');
        ok.className = 'task done'; ok.setAttribute('role', 'status');
        ok.textContent = '✓ 已完成' + (kind === 'fu' ? '追蹤' : '轉介') + '：' + f.getAttribute('data-label');
        d.parentNode.replaceChild(ok, d);
        if (g) { var gn = $('[data-gn]', g); gn.textContent = Math.max(0, +gn.textContent - 1); }
        if (S.tasks) {
          if (kind === 'fu') S.tasks.followups = S.tasks.followups.filter(function (x) { return x.id !== id; });
          else S.tasks.referrals = S.tasks.referrals.filter(function (x) { return x.id !== id; });
          setTaskBadge(S.tasks);
          var n = kind === 'fu' ? S.tasks.followups.length : S.tasks.referrals.length;
          $(kind === 'fu' ? '#fuN' : '#refN').textContent = n;
          if (!n) { var em = document.createElement('div'); em.className = 'empty'; em.textContent = kind === 'fu' ? '沒有待辦追蹤' : '沒有待受理轉介'; $(kind === 'fu' ? '#fuCard' : '#refCard').appendChild(em); }
        }
      };
      $$('form[data-fu]', view).forEach(function (f) {
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!f.result.value) { f.result.classList.add('haserr'); f.result.focus(); return toast('請選擇追蹤結果', 'err'); }
          var persist = radio(f, 'persist');
          if (f.getAttribute('data-beh') && !persist) {
            var pb = f.querySelector('input[name=persist]').closest('.chips');
            if (!f.querySelector('.ferr')) { var d = document.createElement('div'); d.className = 'ferr'; d.textContent = '請確認上次發現的不當用藥行為是否仍持續'; pb.parentNode.insertBefore(d, pb.nextSibling); }
            pb.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          var btn = f.querySelector('button:not([type=button])');
          btn.disabled = true; btn.textContent = '寫入中…';
          var yn = {};
          $$('.orow input[type=radio]:checked', f).forEach(function (x) { if (x.value) yn[x.name.slice(2)] = x.value; });
          api('followup', { id: f.getAttribute('data-fu'), result: f.result.value, outcomesYN: yn, note: f.note.value, persist: persist,
            keyValue: f.keyValue ? f.keyValue.value.trim() : '' })
            .then(function () { done(f, 'fu'); })
            .catch(function (er) { toast(er.message, 'err'); btn.disabled = false; btn.textContent = '完成追蹤'; });
        });
      });
      $$('form[data-ref]', view).forEach(function (f) {
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!f.result.value) return toast('請選擇處理結果', 'err');
          var btn = f.querySelector('button');
          btn.disabled = true; btn.textContent = '寫入中…';
          api('referral', { id: f.getAttribute('data-ref'), result: f.result.value, note: f.note.value })
            .then(function () { done(f, 'ref'); })
            .catch(function (er) { toast(er.message, 'err'); btn.disabled = false; btn.textContent = '完成轉介'; });
        });
      });
    }).catch(function (e) { view.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
  }

  /** v2.7 教師覆核待辦（督導教師）與學習者收到的回饋 */
  function reviewHtml(R, ctxHtml) {
    var mine = R.mine || [], got = R.asLearner || [];
    var h = '';
    if (mine.length || (S.boot.user || {}).learner === 'TCH') {
      h += '<div class="card" id="rvCard"><h2>學員紀錄待我覆核（<span id="rvN">' + mine.length + '</span>）</h2>' +
        (mine.length ? mine.map(function (x) {
          return '<details class="task"><summary><b>' + esc(x.learner || '學員') + '</b>　' + esc(x.packName) + '　' + esc(x.created) + '</summary>' +
            '<form data-rv="' + esc(x.id) + '" data-label="' + esc((x.learner || '學員') + ' ' + x.packName) + '">' + ctxHtml(x.ctx) +
            '<label class="f">覆核結果 <span class="req">*</span></label><div class="chips">' + chip('rvres', '同意', '同意', false, 'radio') + chip('rvres', '需修正', '需修正', false, 'radio') + '</div>' +
            '<label class="f">給學員的回饋 <span class="note">（需修正時必填；學員會在自己的待辦看到）</span></label><textarea name="fb" rows="3" maxlength="2000"></textarea>' +
            '<div class="actions-bar"><button class="btn small">送出覆核</button></div></form></details>';
        }).join('') : '<div class="empty">沒有待覆核紀錄</div>') + '</div>';
    }
    if (isLearner()) {
      h += '<div class="card"><h2>教師給我的回饋</h2>' + (got.length ? '<ul class="fb-list">' + got.map(function (x) {
        return '<li><b>' + esc(x.date) + '　' + esc(x.packName) + '</b>　' + esc(x.teacher) + '：<span class="tag ' + (x.result === '同意' ? 'ok' : 'bad') + '">' + esc(x.result) + '</span>' +
          (x.feedback ? '<div class="note">' + esc(x.feedback) + '</div>' : '') + '</li>';
      }).join('') + '</ul>' : '<div class="empty">尚無覆核回饋</div>') + '</div>';
    }
    return h;
  }

  /* ---------- 病人歷史 ---------- */
  function viewHistory(view) {
    view.innerHTML = '<div class="card"><h2>病人歷史</h2><form id="hf" autocomplete="off"><div class="row two"><div><label class="f">病歷號</label>' +
      '<input type="text" name="mrn" maxlength="20" spellcheck="false"></div><div style="align-self:end"><button class="btn">查詢</button></div></div></form>' +
      '<p class="note">僅顯示您建立、轉介給您職類，或依權限可見之紀錄。查詢會留存稽核紀錄。</p></div><div id="hres"></div>';
    var form = $('#hf');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var mrn = form.mrn.value.trim();
      var out = $('#hres');
      if (!MRN_RE.test(mrn)) { out.innerHTML = '<div class="msg err">病歷號格式（4–20 位英數字）</div>'; return; }
      out.innerHTML = '<div class="sk"><div class="skel"></div><div class="skel"></div></div>';
      vapi('history', { mrn: mrn }).then(function (h) {
        var lastKeys = Object.keys(h.lastByDrug || {});
        out.innerHTML = '<div class="card"><h2>末四碼 ' + esc(h.last4) + '：顯示 ' + h.shown + ' 筆' + (h.total > h.shown ? '（另有 ' + (h.total - h.shown) + ' 筆無權限檢視）' : '') + '</h2>' +
          '<div class="actions-bar left"><button type="button" class="btn" id="hnew">為此病人新增紀錄</button></div>' +
          (lastKeys.length ? '<h3>各藥最近一次技巧評估</h3><table class="t"><thead><tr><th>藥品</th><th>日期</th><th>判定</th><th>未做到</th></tr></thead><tbody>' +
            lastKeys.map(function (c) {
              var x = h.lastByDrug[c];
              return '<tr><td>' + esc(x.brand) + '</td><td>' + esc(x.date) + '</td><td><span class="tag ' + (VERDICT_TAG[x.verdict] || '') + '">' + esc(VERDICT_TEXT[x.verdict] || x.verdict) + '</span></td><td>' + esc((x.failed || []).join('、')) + '</td></tr>';
            }).join('') + '</tbody></table>' : '') +
          (h.items.length ? h.items.map(function (it) {
            return '<div class="card"><div><b>' + esc(it.time) + '</b>　' + esc(it.pack) + '　' + esc(it.role) + (it.legacy ? ' <span class="tag">舊版紀錄</span>' : '') + '</div>' +
              (it.drugs && it.drugs.length ? '<div>藥品：' + esc(it.drugs.map(function (d) { return d.brand; }).join('、')) + '</div>' : '') +
              (it.devices && it.devices.length ? '<div class="note">技巧：' + it.devices.map(function (d) {
                return esc(d.brand) + ' <span class="tag ' + (VERDICT_TAG[d.verdict] || '') + '">' + esc(VERDICT_TEXT[d.verdict] || d.verdict) + '</span>';
              }).join('　') + '</div>' : '') +
              (it.behaviors && it.behaviors.length ? '<div class="loop"><span>發現：' + esc(it.behaviors.join('、')) + '</span><span>介入：' + esc(it.intervention || '—') + '</span><span>追蹤：' +
                esc(it.followup ? (it.followup.status === '完成' ? (it.followup.persist === 'N' ? '行為已改善' : it.followup.persist === 'Y' ? '行為仍持續' : '已完成') + (it.followup.done ? '（' + it.followup.done + '）' : '') : '待辦（到期 ' + it.followup.due + '）') : '未設定') + '</span></div>' : '') +
              (it.question ? '<div>' + esc(it.question) + '</div>' : '') +
              (it.issues.length ? '<div class="note">發現問題：' + esc(it.issues.join('、')) + '</div>' : '') +
              (it.teachback ? '<div class="note">教回：' + esc(it.teachback) + '</div>' : '') +
              (it.actions.length ? '<div class="note">行動計畫：' + esc(it.actions.join('、')) + '</div>' : '') +
              (it.followup ? '<div class="note">追蹤：' + esc(it.followup.status) + '（到期 ' + esc(it.followup.due) + '）' + esc(it.followup.result) + '</div>' : '') +
              '<div class="actions-bar"><button type="button" class="btn ghost small" data-sum="' + esc(it.id) + '">病人版摘要</button>' +
              '<button type="button" class="btn ghost small" data-fix="' + esc(it.id) + '">建立更正紀錄</button>' +
              (it.drugs && it.drugs.length ? '<button type="button" class="btn small" data-redo="' + esc(it.id) + '">同藥複評</button>' : '') + '</div></div>';
          }).join('') : '<div class="empty">無可檢視紀錄</div>') + '</div>';
        $('#hnew').addEventListener('click', function () { startRecord({ mrn: mrn, last: h.lastByDrug || {}, entry: '病人' }); });
        $$('[data-sum]', out).forEach(function (b) {
          b.addEventListener('click', function () {
            api('summary', { recordId: b.getAttribute('data-sum') }).then(showSummary).catch(function (er) { toast(er.message, 'err'); });
          });
        });
        $$('[data-fix]', out).forEach(function (b) {
          b.addEventListener('click', function () {
            var it = h.items.filter(function (x) { return x.id === b.getAttribute('data-fix'); })[0];
            startRecord({ mrn: mrn, last: h.lastByDrug || {}, pack: packLive(it.packCode) ? it.packCode : '', entry: '病人', fix: it.id });
          });
        });
        $$('[data-redo]', out).forEach(function (b) {
          b.addEventListener('click', function () {
            var it = h.items.filter(function (x) { return x.id === b.getAttribute('data-redo'); })[0];
            startRecord({ mrn: mrn, last: h.lastByDrug || {}, drugs: it.drugs.map(function (d) { return d.code; }).filter(function (c) { return S.drugIdx[c]; }),
              pack: packLive(it.packCode) ? it.packCode : '', entry: '病人' });
          });
        });
      }).catch(function (er) { out.innerHTML = '<div class="msg err">' + esc(er.message) + '</div>'; });
    });
    if (S.histMrn) { form.mrn.value = S.histMrn; S.histMrn = ''; form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit')); }
    else form.mrn.focus();
  }

  /* ---------- 成效儀表板（v2.6：科／面向／本人／學員四視圖＋裝置與藥品） ---------- */
  function ymShift(ym, n) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + (m < 9 ? '0' : '') + (m + 1); }
  function m12Of(ym) { var a = []; for (var k = 11; k >= 0; k--) a.push(ymShift(ym, -k)); return a; }
  /** 12 個月趨勢：灰線、最後一點藍色、目標值灰虛線；缺值（樣本不足）斷線 */
  function spark(points, target, w) {
    w = w || 120; var h = 32;
    var vs = points.filter(function (p) { return p !== null; });
    if (vs.length < 2) return '<span class="note">—</span>';
    var n = points.length, d = '', last = null;
    // 縱軸依資料自動縮放（含目標值），上下各留 5 個百分點，限制在 0–100；避免 80–92% 的變化被壓成一直線
    var dom = vs.concat(target !== null && target !== undefined ? [target] : []);
    var lo = Math.max(0, Math.min.apply(null, dom) - 5), hi = Math.min(100, Math.max.apply(null, dom) + 5);
    if (hi - lo < 10) { var mid = (hi + lo) / 2; lo = Math.max(0, mid - 5); hi = Math.min(100, mid + 5); }
    var X = function (i) { return (i / (n - 1)) * (w - 6) + 3; }, Y = function (v) { return h - 3 - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo || 1)) * (h - 6); };
    points.forEach(function (v, i) {
      if (v === null) return;
      d += (d && points[i - 1] !== null ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); last = i;
    });
    var label = '近 12 個月（縱軸 ' + Math.round(lo) + '–' + Math.round(hi) + '%）：' + points.map(function (v) { return v === null ? '無' : v + '%'; }).join('、');
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' +
      (target !== null && target !== undefined ? '<line x1="0" x2="' + w + '" y1="' + Y(target).toFixed(1) + '" y2="' + Y(target).toFixed(1) + '" class="sp-target"/>' : '') +
      '<path d="' + d + '" class="sp-line"/>' + (last !== null ? '<circle cx="' + X(last).toFixed(1) + '" cy="' + Y(points[last]).toFixed(1) + '" r="2.6" class="sp-dot"/>' : '') + '</svg>';
  }
  /** 0–100% 橫條＋目標刻度 */
  function gapBar(rate, target, small) {
    if (rate === null || rate === undefined || rate === '' || small) return '<span aria-hidden="true"></span>';
    return '<span class="gap" aria-hidden="true"><span class="fill" style="width:' + Math.max(0, Math.min(100, rate)) + '%"></span>' +
      (target !== null && target !== undefined ? '<span class="tick" style="left:' + Math.max(0, Math.min(100, target)) + '%"></span>' : '') + '</span>';
  }
  /** 科內分布帶：四分位區間、中位數刻度、本人點 */
  function band(dist, own) {
    if (!dist) return '<span class="note">科內可比較人數不足（需 ≥3 位同仁分母 ≥5）</span>';
    var p = function (v) { return Math.max(0, Math.min(100, v)) + '%'; };
    return '<span class="band" role="img" aria-label="' + esc('科內中位數 ' + dist.median + '%，四分位 ' + dist.q1 + '–' + dist.q3 + '%（' + dist.n + ' 人）' + (own === null ? '' : '；本人 ' + own + '%')) + '">' +
      '<span class="iqr" style="left:' + p(dist.q1) + ';width:' + Math.max(1, dist.q3 - dist.q1) + '%"></span><span class="med" style="left:' + p(dist.median) + '"></span>' +
      (own === null ? '' : '<span class="me" style="left:' + p(own) + '"></span>') + '</span><span class="note">科內中位數 ' + dist.median + '%（' + dist.n + ' 人）</span>';
  }
  function pct(num, den) { return den ? Math.round(num / den * 1000) / 10 : null; }
  function byCodeOf(rows) {
    var by = {}, order = [];
    rows.forEach(function (r) { if (!by[r.code]) { by[r.code] = { code: r.code, name: r.name, type: r.type, m: {} }; order.push(r.code); } by[r.code].m[r.ym] = r; });
    return { by: by, order: order };
  }
  function rateTxt(r) {
    if (!r) return '<span class="note">本月無資料</span>';
    if (r.small) return '<span class="note">n＝' + r.den + '，樣本不足</span>';
    if (r.rate === null && r.median !== null && r.median !== undefined && r.median !== '') return '<b>中位數 ' + r.median + '</b><span class="note">　n＝' + r.den + '</span>';
    if (r.rate === null) return (r.num === null ? '—' : r.num) + (r.den !== null && r.den !== undefined && r.den !== '' ? '<span class="note">／' + r.den + '</span>' : '');
    return '<b>' + r.rate + '%</b><span class="note">　' + r.num + '／' + r.den + '</span>';
  }
  function deltaTxt(cur, prev) {
    if (!cur || !prev || cur.rate === null || prev.rate === null || cur.small || prev.small) return '';
    var d = Math.round((cur.rate - prev.rate) * 10) / 10;
    return '<span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '＝ ') + Math.abs(d) + ' 個百分點</span>';
  }
  /** 結論卡：大數字＋一句話＋與上月差＋12 月趨勢 */
  function dcard(x, ym, sentence) {
    if (!x) return '';
    var cur = x.m[ym], prev = x.m[ymShift(ym, -1)];
    var big = !cur ? '—' : cur.small ? '<span class="small-n">樣本不足</span>' : cur.rate === null ? (cur.num === null ? '—' : cur.num) : cur.rate + '%';
    var t = cur && cur.target !== null && cur.target !== undefined ? cur.target : null;
    return '<div class="dcard"><div class="dk">' + esc(x.name.replace(/^[^：]+：/, '')) + '</div><div class="big">' + big + '</div>' +
      '<div class="ds">' + (cur && cur.den !== null && cur.den !== undefined && cur.den !== '' && cur.rate !== null ? cur.num + '／' + cur.den + '　' : '') + esc(sentence || '') + '</div>' +
      '<div class="dfoot">' + deltaTxt(cur, prev) + spark(m12Of(ym).map(function (m) { var r = x.m[m]; return r && r.rate !== null && !r.small ? r.rate : null; }), t, 110) + '</div></div>';
  }
  function defHtml(code, defs) {
    var d = (defs || {})[code];
    if (!d) return '<div class="note">指標代碼 ' + esc(code) + '</div>';
    var line = function (k, v) { return v ? '<div><b>' + k + '</b>　' + esc(v) + '</div>' : ''; };
    return '<div class="def">' + line('代碼', code) + line('分子', d.num) + line('分母', d.den || '該面向全部新版紀錄') + line('排除', d.exc) +
      line('資料來源', d.src) + line('外部對照', d.ext) + line('說明', d.note) + line('目標值來源', d.targetSrc) + '</div>';
  }
  /** v2.6.1 歷年彙總：含舊系統歸檔紀錄；比率以年度分子／分母加總計算 */
  function yearsTable(years, pk) {
    if (!years || !years.length) return '';
    var minN = S.boot.settings.minN || 10;
    var r = function (o) { return !o || !o.den ? '<td class="num">—</td>' : o.den < minN ? '<td class="num small-n" title="n＝' + o.den + '">n' + o.den + '</td>' :
      '<td class="num">' + (Math.round(o.num / o.den * 1000) / 10) + '%<span class="note">　' + o.num + '／' + o.den + '</span></td>'; };
    var hist = pk !== 'ALL' && !(S.boot.allPacks || []).some(function (x) { return x.code === pk; });
    return '<details class="card sub" open><summary><h2>歷年彙總（含舊系統歸檔紀錄）</h2></summary>' +
      '<div class="note">舊系統（2026-11 正式切換前）只有面向、問題分類、發現問題、跨職類需求、病人來源與滿意度；教回、追蹤等指標僅新版紀錄有值。滿意度三種量表題目不同，分欄呈現不混算。' + (hist ? '本面向已停用，僅保留歷史統計。' : '') + '</div>' +
      '<div class="tablewrap"><table class="t"><thead><tr><th>年</th><th>有紀錄月數</th><th>人次</th><th>問題發現率</th><th>跨職類需求提出率</th><th>教回完全（新版）</th><th>舊版滿意度 9–10 分</th><th>V2 滿意度 ≥4 分</th><th>V3 滿意度 9–10 分</th></tr></thead><tbody>' +
      years.slice().reverse().map(function (y) {
        return '<tr><td>' + esc(y.y) + '</td><td class="num">' + (y.months || 0) + '</td><td class="num">' + ((y.n || {}).num || 0) + '</td>' + r(y.issue) + r(y.needs) + r(y.tb) + r(y.satV1) + r(y.satV2) + r(y.satV3) + '</tr>';
      }).join('') + '</tbody></table></div></details>';
  }
  /** 指標列：依類型分組；每列可展開定義 */
  function indicatorList(rows, ym, defs, pk) {
    var B = byCodeOf(rows), m12 = m12Of(ym);
    var types = ['結果', '過程', '平衡', '結構'];
    var isSmall = function (c) { var cur = B.by[c].m[ym]; return !cur || cur.small; };
    var item = function (c) {
      var x = B.by[c], cur = x.m[ym], prev = x.m[ymShift(ym, -1)];
      var extra = cur && cur.rate !== null && cur.median !== null && cur.median !== undefined && cur.median !== '' ? '<span class="note">　中位數 ' + cur.median + (cur.mean !== null && cur.mean !== undefined && cur.mean !== '' ? '／平均 ' + cur.mean : '') + '</span>' : '';
      return '<details class="ind"><summary><span class="iname">' + esc(x.name) + '</span><span class="ival">' + rateTxt(cur) + extra + '</span>' +
        gapBar(cur && cur.rate, cur && cur.target, cur && cur.small) + '<span class="itr">' + deltaTxt(cur, prev) +
        spark(m12.map(function (m) { var r = x.m[m]; return r && r.rate !== null && !r.small ? r.rate : null; }), cur ? cur.target : null) + '</span></summary>' + defHtml(c, defs) + '</details>';
    };
    if (!B.order.length) {
      // v2.6.0：無資料時仍列出本面向已定義指標（含定義），讓使用者知道會追蹤什麼
      var dk = Object.keys(defs || {}).filter(function (c) { return pk && defs[c].pack === pk && defs[c].name; }).sort();
      return '<div class="empty">所選期間無資料</div>' + (dk.length ? '<div class="ilist">' + dk.map(function (c) {
        return '<details class="ind"><summary><span class="iname">' + esc(defs[c].name) + '</span><span class="ival"><span class="small-n">本期無資料</span></span></summary>' + defHtml(c, defs) + '</details>'; }).join('') + '</div>' : '');
    }
    var big = B.order.filter(function (c) { return !isSmall(c); }), small = B.order.filter(isSmall);
    var out = types.map(function (t) {
      var list = big.filter(function (c) { return B.by[c].type === t; });
      return list.length ? '<h3 class="itype">' + t + '指標</h3><div class="ilist">' + list.map(item).join('') + '</div>' : '';
    }).join('');
    return (out || '<div class="empty">本月所有指標樣本不足（分母低於 ' + S.boot.settings.minN + '）</div>') +
      (small.length ? '<details class="sub"><summary>樣本不足或本月無資料（' + small.length + '）</summary><div class="ilist">' + small.map(item).join('') + '</div></details>' : '');
  }
  function csvDownload(name, rows) {
    var q = function (v) { v = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var head = ['年月', '指標代碼', '指標名稱', '類型', '分子', '分母', '比率', '樣本不足', '目標值'];
    var body = rows.map(function (r) { return [r.ym, r.code, r.name, r.type, r.num, r.den, r.rate, r.small ? 'Y' : '', r.target].map(q).join(','); });
    var blob = new Blob(['﻿' + [head.join(',')].concat(body).join('\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  /* ---------- v2.7：管制圖、改善看板、學習歷程、資料品質（數字一律讀後端彙總表，兩站同源） ---------- */
  var SPC_BASE_TXT = { r24: '近 24 個月', all: '全部月份', first24: '最初 24 個月' };
  function spcGroup(rows) {
    var by = {}, order = [];
    rows.forEach(function (r) { if (!by[r.code]) { by[r.code] = { code: r.code, name: r.name, type: r.type, dir: r.dir, pts: [] }; order.push(r.code); } by[r.code].pts.push(r); });
    order.forEach(function (c) { by[c].pts.sort(function (a, b) { return a.ym < b.ym ? -1 : 1; }); var l = by[c].pts[by[c].pts.length - 1]; by[c].st = l.st; by[c].cls = l.cls; });
    return { by: by, order: order };
  }
  function spcFmt(type, v) { return v === null || v === undefined ? '—' : type === 'u' ? String(Math.round(v * 10) / 10) : (Math.round(v * 1000) / 10) + '%'; }
  /** SPC 圖：每點界限（p 圖隨分母變動）、各階段中心線分開畫、訊號點紅色、當月未完空心 */
  function spcChart(s, months) {
    var P = s.pts.slice(-(months || 24)); if (!P.length) return '<div class="note">無資料</div>';
    var w = 640, h = 190, L = 44, R = 10, T = 10, B = 26;
    var vals = []; P.forEach(function (p) { [p.v, p.ucl, p.lcl, p.cl].forEach(function (v) { if (v !== null && v !== undefined) vals.push(v); }); });
    if (!vals.length) return '<div class="note">無可畫數值</div>';
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    if (s.type === 'p') { lo = Math.max(0, lo - 0.03); hi = Math.min(1, hi + 0.03); } else { lo = Math.max(0, lo - 1); hi = hi + 1; }
    if (hi - lo < 1e-6) hi = lo + 1;
    var n = P.length, X = function (i) { return L + (n === 1 ? (w - L - R) / 2 : i / (n - 1) * (w - L - R)); }, Y = function (v) { return T + (1 - (v - lo) / (hi - lo)) * (h - T - B); };
    var path = function (key) { var d = ''; P.forEach(function (p, i) { var v = p[key]; if (v === null || v === undefined) { d += ' '; return; } d += (d && d.slice(-1) !== ' ' && P[i - 1] && P[i - 1].phase === p.phase ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }); return d.replace(/ +/g, ' ').trim(); };
    var g = '';
    [0, 0.5, 1].forEach(function (f) { var v = lo + (hi - lo) * f; g += '<line class="spc-grid" x1="' + L + '" x2="' + (w - R) + '" y1="' + Y(v).toFixed(1) + '" y2="' + Y(v).toFixed(1) + '"/><text class="spc-ax" x="' + (L - 4) + '" y="' + (Y(v) + 4).toFixed(1) + '" text-anchor="end">' + esc(spcFmt(s.type, v)) + '</text>'; });
    P.forEach(function (p, i) { if (i > 0 && P[i - 1].phase !== p.phase) g += '<line class="spc-cut" x1="' + ((X(i) + X(i - 1)) / 2).toFixed(1) + '" x2="' + ((X(i) + X(i - 1)) / 2).toFixed(1) + '" y1="' + T + '" y2="' + (h - B) + '"/><text class="spc-ax" x="' + ((X(i) + X(i - 1)) / 2 + 3).toFixed(1) + '" y="' + (T + 10) + '">' + esc(p.phase) + '</text>'; });
    g += '<path class="spc-cl" d="' + path('cl') + '"/><path class="spc-lim" d="' + path('ucl') + '"/><path class="spc-lim" d="' + path('lcl') + '"/><path class="spc-line" d="' + path('v') + '"/>';
    P.forEach(function (p, i) {
      if (p.v === null) return;
      var cls = p.sig ? 'sig' : p.part ? 'part' : '';
      g += '<circle class="spc-pt ' + cls + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="3.2"><title>' + esc(p.ym + '　' + spcFmt(s.type, p.v) + (s.type === 'p' ? '（' + p.x + '／' + p.n + '）' : '') + (p.sig ? '　訊號：' + p.sig : '') + (p.part ? '　當月未完' : '')) + '</title></circle>';
    });
    var step = Math.max(1, Math.ceil(n / 8));
    P.forEach(function (p, i) { if (i % step === 0 || i === n - 1) g += '<text class="spc-ax" x="' + X(i).toFixed(1) + '" y="' + (h - 8) + '" text-anchor="middle">' + esc(p.ym.slice(2)) + '</text>'; });
    var last = P[n - 1];
    var label = s.name + '：' + P.map(function (p) { return p.ym + ' ' + spcFmt(s.type, p.v) + (p.sig ? '（訊號）' : ''); }).join('、');
    return '<svg class="spcsvg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' + g + '</svg>' +
      '<div class="note">中心線 ' + spcFmt(s.type, last.cl) + (last.from ? '（基線 ' + esc(last.from) + '～' + esc(last.to) + '，' + last.bn + ' 個月）' : '') + '；虛線＝管制上下限（3σ）；紅點＝特殊原因訊號；空心點＝當月未完（不納入界限）。</div>';
  }
  function spcPanel(rows, base, fixed) {
    var G = spcGroup(rows);
    if (!G.order.length) return '<div class="card"><h2>統計製程管制（SPC）</h2><div class="empty">尚無管制圖資料（請確認已執行彙總）</div></div>';
    var cls = { good: 'ok', bad: 'bad', neu: 'warn', stable: '', na: 'muted' };
    return '<div class="card"><h2>統計製程管制（SPC）</h2><div class="row two"><div>' + (fixed ? '<div class="note">基線：近 24 個月（面向層級固定）</div>' : '<label class="f" for="spcBase">基線</label><select id="spcBase">' +
      Object.keys(SPC_BASE_TXT).map(function (k) { return '<option value="' + k + '"' + (k === base ? ' selected' : '') + '>' + SPC_BASE_TXT[k] + '</option>'; }).join('') + '</select>') + '</div>' +
      '<div class="note">' + esc((S.boot.settings.spcCut || '2026-11') + ' 新平台上線為已知特殊原因：前後各自計算管制界限。p 圖＝比率、u 圖＝每月人次。') + '</div></div>' +
      '<div class="spcgrid">' + G.order.map(function (c) {
        var s = G.by[c];
        return '<details class="spc"' + (s.cls === 'bad' || s.cls === 'good' || s.cls === 'neu' ? ' open' : '') + '><summary><span class="iname">' + esc(s.name) + '</span><span class="spcst ' + (cls[s.cls] || '') + '">' + esc(s.st || '—') + '</span></summary>' + spcChart(s, 24) + '</details>';
      }).join('') + '</div></div>';
  }
  /** 19 疾病面向：當月人次 vs 每月目標（目標唯一來源＝疾病包登錄） */
  function targetMatrix(targets, packSummary, ym) {
    if (!targets || !targets.length) return '';
    var n = {}; (packSummary || []).forEach(function (p) { n[p.code] = p.n; });
    return '<div class="card"><h2>疾病面向每月目標（' + esc(ym) + '）</h2><div class="note">目標值唯一來源＝控制台「疾病包登錄」每月目標人次；桃e 讀同一彙總表，數字一致。</div>' +
      '<div class="tablewrap"><table class="t"><thead><tr><th>面向</th><th>當月人次</th><th>每月目標</th><th>達成</th><th>目標來源</th></tr></thead><tbody>' +
      targets.map(function (t) {
        var v = n[t.code] || 0, tg = t.target, r = tg ? Math.round(v / tg * 1000) / 10 : null;
        return '<tr><td>' + esc(t.name) + '</td><td class="num">' + v + '</td><td class="num">' + (tg || '<span class="note">未設定</span>') + '</td><td>' + (r === null ? '—' : gapBar(Math.min(100, r), 100) + ' ' + r + '%') + '</td><td class="note">' + esc(t.src || '') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  function checksumLine(ins) { return ins && ins.checksum ? '<div class="note chk">月報核對碼 <code>' + esc(ins.checksum) + '</code>（桃e 顯示相同代碼即代表兩站數字同源一致）</div>' : ''; }
  /** 學習歷程（PGY／UGY）：自到職日累計 */
  function learnerPanel(rows, pid) {
    var mine = rows.filter(function (r) { return r.pid === pid; }).sort(function (a, b) { return a.ym < b.ym ? -1 : 1; });
    if (!mine.length) return '<div class="empty">尚無學習紀錄</div>';
    var who = mine[mine.length - 1], st = (who.start || '').slice(0, 7);
    var cum = mine.filter(function (r) { return !st || r.ym >= st; });
    var t = { n: 0, ep: 0, epO: 0, epI: 0, f1: 0, f1d: 0, f2: 0, f2d: 0, ind: 0, pres: 0, rev: 0, revPend: 0, revDone: 0, beh: 0 }, packs = {};
    cum.forEach(function (r) { Object.keys(t).forEach(function (k) { t[k] += r[k] || 0; }); r.packs.forEach(function (p) { if (p) packs[p] = 1; }); });
    var np = Object.keys(packs).length, isPgy = who.type === 'PGY', goal = 10;
    var r = function (a, b) { return b ? pct(a, b) + '%<span class="note">　' + a + '／' + b + '</span>' : '—'; };
    var sup = t.ind + t.pres + t.rev;
    return '<div class="dcards">' +
      '<div class="dcard"><div class="dk">門診病人衛教人次（EPA 3）' + (st ? '（' + esc(who.start.slice(0, 10)) + ' 起）' : '') + '</div><div class="big">' + t.epO + '</div>' +
      (isPgy ? '<div class="ds">參考門檻 ' + goal + ' 例：' + (t.epO >= goal ? '已達' : '尚差 ' + (goal - t.epO) + ' 例') + '（門檻待教學委員會簽核；人次＝同病人同日同面向計 1）</div>' + gapBar(Math.min(100, t.epO / goal * 100), 100) : '<div class="ds">UGY 僅計本人紀錄</div>') + '</div>' +
      '<div class="dcard"><div class="dk">住院／出院前衛教人次（EPA 5 佐證）</div><div class="big">' + t.epI + '</div><div class="ds">全部人次 ' + t.ep + '｜紀錄筆數 ' + t.n + '</div></div>' +
      '<div class="dcard"><div class="dk">首次教回完全理解</div><div class="big">' + (t.f1d ? pct(t.f1, t.f1d) + '%' : '—') + '</div><div class="ds">' + t.f1 + '／' + t.f1d + '　補強後最終 ' + r(t.f2, t.f2d) + '</div></div>' +
      '<div class="dcard"><div class="dk">涵蓋疾病面向</div><div class="big">' + np + '</div><div class="ds">' + esc(Object.keys(packs).join('、')) + '</div></div>' +
      '<div class="dcard"><div class="dk">督導方式</div><div class="big">' + (sup ? pct(t.ind, sup) + '%' : '—') + '</div><div class="ds">獨立 ' + t.ind + '／教師在場 ' + t.pres + '／事後覆核 ' + t.rev + '（獨立占比僅供信任等級參考，非判定）</div></div>' +
      '<div class="dcard"><div class="dk">教師覆核</div><div class="big">' + t.revDone + '／' + (t.revDone + t.revPend) + '</div><div class="ds">待覆核 ' + t.revPend + '</div></div>' +
      '<div class="dcard"><div class="dk">發現用藥不當行為</div><div class="big">' + t.beh + '</div><div class="ds">件數（病人層級）</div></div></div>' +
      '<div class="tablewrap"><table class="t"><thead><tr><th>月份</th><th>人次（門診／住院）</th><th>紀錄筆數</th><th>首次教回完全</th><th>最終教回完全</th><th>督導（獨立／在場／覆核）</th><th>覆核完成／待辦</th></tr></thead><tbody>' +
      mine.slice().reverse().map(function (x) { return '<tr><td>' + esc(x.ym) + '</td><td class="num">' + (x.ep || 0) + '（' + (x.epO || 0) + '／' + (x.epI || 0) + '）</td><td class="num">' + x.n + '</td><td>' + r(x.f1, x.f1d) + '</td><td>' + r(x.f2, x.f2d) + '</td><td>' + x.ind + '／' + x.pres + '／' + x.rev + '</td><td>' + x.revDone + '／' + x.revPend + '</td></tr>'; }).join('') +
      '</tbody></table></div>';
  }
  function dqPanel(dq) {

    var ks = Object.keys(dq || {});
    if (!ks.length) return '<div class="card"><h2>資料品質</h2><div class="empty">尚無資料品質指標</div></div>';
    return '<div class="card"><h2>資料品質（近 3 個月，全部面向）</h2><div class="tablewrap"><table class="t"><thead><tr><th>指標</th><th>月份</th><th>值</th></tr></thead><tbody>' +
      ks.sort().map(function (k) { return dq[k].map(function (x, i) {
        var v = x.rate !== null ? x.rate + '%<span class="note">　' + x.num + '／' + x.den + '</span>' : x.median !== null ? '中位數 ' + x.median : (x.num === null ? '—' : x.num);
        return '<tr>' + (i === 0 ? '<td rowspan="' + dq[k].length + '">' + esc(x.name || k) + '<span class="note">　' + esc(k) + '</span></td>' : '') + '<td>' + esc(x.ym) + '</td><td>' + v + '</td></tr>'; }).join(''); }).join('') +
      '</tbody></table></div></div>';
  }
  function kanbanHtml(d) {
    var cols = d.states;
    return '<div class="card"><h2>改善看板</h2><div class="note">每月彙總時，最近一個完整月份出現 SPC 特殊原因訊號的指標會自動建卡（同指標同月份只建一次）。' + (d.canEdit ? '可更新狀態、負責人、原因假設與 PDSA。' : '僅組長（L2）以上可編輯。') + '</div>' +
      '<div class="kanban">' + cols.map(function (st) {
        var cs = d.cards.filter(function (c) { return c.status === st; });
        return '<section class="kcol"><h3>' + esc(st) + '<span class="note">　' + cs.length + '</span></h3>' + (cs.length ? cs.map(function (c) {
          return '<details class="kcard ' + (c.read === '惡化' ? 'bad' : c.read === '改善' ? 'good' : '') + '"><summary><b>' + esc(c.name) + '</b><div class="note">' + esc(c.packName + '｜' + c.ym + '｜' + c.read + '｜' + c.sig) + '</div></summary>' +
            (d.canEdit ? '<form data-kb="' + esc(c.id) + '"><label class="f">狀態</label><select name="status">' + cols.map(function (s) { return '<option' + (s === c.status ? ' selected' : '') + '>' + esc(s) + '</option>'; }).join('') + '</select>' +
              '<label class="f">負責人</label><input name="owner" maxlength="100" value="' + esc(c.owner) + '"><label class="f">原因假設</label><textarea name="cause" maxlength="500" rows="2">' + esc(c.cause) + '</textarea>' +
              '<label class="f">PDSA</label><textarea name="pdsa" maxlength="500" rows="2">' + esc(c.pdsa) + '</textarea><button class="btn small" type="submit">儲存</button><span class="note">　更新 ' + esc(c.updated) + '</span></form>'
              : '<div class="note">負責人 ' + esc(c.owner || '—') + '<br>原因假設 ' + esc(c.cause || '—') + '<br>PDSA ' + esc(c.pdsa || '—') + '</div>') + '</details>';
        }).join('') : '<div class="note">—</div>') + '</section>';
      }).join('') + '</div></div>';
  }
  /* ---------- v2.8：區間篩選、病人來源切片、人次去重後之科總覽（D8–D13） ---------- */
  function ymSeq(a, b) { var o = []; if (!a || !b || a > b) return o; var m = a; while (m <= b && o.length < 400) { o.push(m); m = ymShift(m, 1); } return o; }
  var QUICK = [['R3', '近 3 月'], ['R6', '近 6 月'], ['R12', '近 12 月'], ['R24', '近 24 月'], ['YTD', '本年度'], ['ALLT', '全期']];
  var SRC_TXT = { ALL: '全部來源', OPD: '門診', IPD: '住院', ER: '急診', BR: '分院', COMM: '社區', HOME: '居家', TEL: '電話／遠距', DC: '出院前（住院）', UNK: '未填（舊系統）' };
  /** 快選 → 起訖（皆含當月；當月為進行中，趨勢線以空心點標示樣本不足） */
  function quickRange(q, nowYm, minYm) {
    var lc = nowYm, n = { R3: 3, R6: 6, R12: 12, R24: 24 }[q];
    if (n) return { from: ymShift(lc, -(n - 1)), to: lc };
    if (q === 'YTD') return { from: nowYm.slice(0, 4) + '-01', to: nowYm };
    return { from: minYm || ymShift(nowYm, -23), to: nowYm };
  }
  /** 區間彙總：同代碼分子、分母相加（不是月比率平均） */
  function aggRange(x, months) {
    var o = { num: 0, den: 0, n: 0, hasDen: false, median: null };
    if (!x) return null;
    months.forEach(function (m) { var r = x.m[m]; if (!r) return; o.n++; o.num += r.num || 0; if (r.den !== null && r.den !== undefined && r.den !== '') { o.den += r.den; o.hasDen = true; } if (r.median !== null && r.median !== undefined && r.median !== '') o.median = r.median; });
    if (!o.n) return null;
    var minN = S.boot.settings.minN || 10;
    o.small = o.hasDen && o.den < minN;
    o.rate = o.hasDen && o.den && !o.small ? Math.round(o.num / o.den * 1000) / 10 : null;
    return o;
  }
  function deltaPP(cur, prev) {
    if (!cur || !prev || cur.rate === null || prev.rate === null) return '<span class="note">前期無可比</span>';
    var d = Math.round((cur.rate - prev.rate) * 10) / 10;
    return '<span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '＝ ') + Math.abs(d) + ' 個百分點</span><span class="note"> 對前一等長區間</span>';
  }
  function deltaN(cur, prev) {
    if (!prev) return '<span class="note">前期無資料</span>';
    var d = Math.round((cur - prev) / prev * 1000) / 10;
    return '<span class="delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') + '">' + (d > 0 ? '▲ ' : d < 0 ? '▼ ' : '＝ ') + Math.abs(d) + '%</span><span class="note"> 對前期 ' + prev + '</span>';
  }
  /** 區間趨勢線（月為點）：比率或件數；分母不足之月為空心點不連線；切分月畫虛線 */
  function trendSvg(x, months, kind, cut, w) {
    w = w || 180; var h = 40, minN = S.boot.settings.minN || 10;
    var pts = months.map(function (m) { var r = x && x.m[m]; if (!r) return null; if (kind === 'n') return { m: m, v: r.num || 0 }; return r.den && r.den >= minN ? { m: m, v: r.num / r.den * 100 } : (r.den ? { m: m, v: r.num / r.den * 100, weak: true } : null); });
    var vs = pts.filter(Boolean).map(function (p) { return p.v; });
    if (vs.length < 2) return '<span class="note">趨勢資料不足</span>';
    var lo = kind === 'n' ? 0 : Math.max(0, Math.min.apply(null, vs) - 5), hi = kind === 'n' ? Math.max.apply(null, vs) || 1 : Math.min(100, Math.max.apply(null, vs) + 5);
    if (hi - lo < 1e-9) hi = lo + 1;
    var n = months.length, X = function (i) { return n === 1 ? w / 2 : 3 + i / (n - 1) * (w - 6); }, Y = function (v) { return h - 4 - (v - lo) / (hi - lo) * (h - 8); };
    var d = '', prevOk = false, g = '';
    pts.forEach(function (p, i) {
      if (cut && months[i] === cut && i > 0) g += '<line class="tr-cut" x1="' + X(i - 0.5).toFixed(1) + '" x2="' + X(i - 0.5).toFixed(1) + '" y1="0" y2="' + h + '"/>';
      if (!p || p.weak) { prevOk = false; return; }
      d += (prevOk ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.v).toFixed(1); prevOk = true;
    });
    pts.forEach(function (p, i) { if (p) g += '<circle class="' + (p.weak ? 'tr-weak' : 'tr-dot') + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(p.v).toFixed(1) + '" r="2.2"><title>' + esc(p.m + '：' + (kind === 'n' ? p.v : Math.round(p.v * 10) / 10 + '%') + (p.weak ? '（分母不足）' : '')) + '</title></circle>'; });
    var label = (kind === 'n' ? '逐月人次：' : '逐月比率：') + pts.map(function (p, i) { return months[i] + ' ' + (p ? (kind === 'n' ? p.v : Math.round(p.v * 10) / 10 + '%') : '無'); }).join('、');
    return '<svg class="trend" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(label) + '">' + g + '<path class="tr-line" d="' + d + '"/></svg>';
  }
  /** KPI 卡（比率）：區間值、分子／分母、前期比較、逐月趨勢；分母不足時提示放寬 */
  function kpiCard(title, x, R, sentence, opts) {
    opts = opts || {};
    var cur = aggRange(x, R.months), prev = aggRange(x, R.prev);
    var big = !cur ? '—' : cur.small ? '<span class="small-n">n＝' + cur.den + '</span>' : cur.rate === null ? '—' : cur.rate + '%';
    var hint = cur && cur.small ? '<div class="note">本區間分母不足 ' + (S.boot.settings.minN || 10) + '，<button type="button" class="linkbtn" data-widen="1">放寬為全期</button></div>' : '';
    return '<div class="dcard kcard2' + (opts.lowGood ? ' lowgood' : '') + '"><div class="dk">' + esc(title) + (opts.tag ? ' <span class="tag">' + esc(opts.tag) + '</span>' : '') + '</div><div class="big">' + big + '</div>' +
      '<div class="ds">' + (cur && cur.hasDen ? cur.num + '／' + cur.den + '　' : '') + esc(sentence || '') + '</div>' + hint +
      '<div class="dfoot">' + (cur && !cur.small ? deltaPP(cur, prev) : '') + trendSvg(x, R.months, 'rate', R.cut) + '</div></div>';
  }
  /** 追蹤漏斗（O6）：應追蹤 → 已到期 → 完成 → 準時完成 */
  function funnelHtml(g, R) {
    var a = function (c, k) { var s = aggRange(g(c), R.months); return s ? s[k] : 0; };
    var st = [['應追蹤（需追蹤＝是）', a('O6', 'num')], ['已到期', a('C6', 'den')], ['已完成', a('C6', 'num')], ['到期後 7 日內完成', a('G5', 'num')]];
    var top = Math.max(1, st[0][1], st[1][1]);
    return '<div class="card"><h2>追蹤漏斗</h2><div class="note">結果指標（核心藥持續、警訊複述、未非計畫就醫）只來自已完成追蹤；卡在哪一關，結果就缺在哪裡。</div><div class="funnel">' +
      st.map(function (s, i) {
        var conv = i && st[i - 1][1] ? Math.round(s[1] / st[i - 1][1] * 100) + '%' : '';
        return '<div class="fstep"><span class="flabel">' + esc(s[0]) + '</span><span class="fbar"><span style="width:' + Math.max(2, s[1] / top * 100) + '%"></span></span><span class="fnum">' + s[1] + '</span><span class="note fconv">' + (conv ? '承接 ' + conv : '') + '</span></div>';
      }).join('') + '</div></div>';
  }
  function heatClass(p) { return p === null ? 'hn' : p >= 100 ? 'h4' : p >= 75 ? 'h3' : p >= 50 ? 'h2' : p >= 25 ? 'h1' : 'h0'; }
  /** 面向 × 月熱圖：面向人次 ÷ 每月目標（只畫疾病面向；季判讀面向另標） */
  function heatmapHtml(ps, R) {
    var dz = ps.filter(function (p) { return p.cls === '疾病' || p.cls === '跨職類'; });
    if (!dz.length) return '';
    var ms = R.months.slice(-24);
    return '<div class="card"><h2>疾病面向 × 月：目標達成</h2><div class="note">色階＝當月面向人次 ÷ 每月目標（0–24／25–49／50–74／75–99／≥100%）；斜線＝未設目標；' + esc(R.cut) + ' 前為舊系統（多數紀錄無疾病面向，不列入目標分母）。點面向名稱進入該面向。</div>' +
      '<div class="tablewrap"><table class="t heat"><thead><tr><th>面向</th>' + ms.map(function (m) { return '<th class="hm">' + esc(m.slice(2).replace('-', '/')) + '</th>'; }).join('') + '<th>區間達成</th></tr></thead><tbody>' +
      dz.map(function (p) {
        return '<tr><td><button type="button" class="linkbtn" data-goPack="' + esc(p.code) + '">' + esc(p.name) + '</button>' + (p.period === '季' ? '<span class="tag">季判讀</span>' : '') + (p.cls === '跨職類' ? '<span class="tag">跨職類</span>' : '') + '</td>' +
          ms.map(function (m) { var c = p.m[m] || {}, v = c.t1 !== undefined ? c.t1 : (c.n || 0), pc = p.target && m >= R.cut ? Math.round(v / p.target * 100) : null;
            return '<td class="hc ' + (m < R.cut ? 'old' : heatClass(pc)) + '" title="' + esc(m + '：' + v + ' 人次' + (p.target ? '／目標 ' + p.target : '')) + '">' + (m < R.cut ? '' : v || '') + '</td>'; }).join('') +
          '<td class="num">' + (p.tAch === null || p.tAch === undefined ? '<span class="note">未設目標</span>' : p.tAch + '%<span class="note">　' + p.tNum + '／' + p.tDen + '</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  /** 疾病小倍數：每面向主顯 3 項（D12），同一 0–100% 刻度 */
  function smallMultiples(ps, defs, R) {
    var dz = ps.filter(function (p) { return (p.cls === '疾病' || p.cls === '跨職類') && (p.n || Object.keys(p.k).length); });
    var none = ps.filter(function (p) { return (p.cls === '疾病' || p.cls === '跨職類') && !p.n && !Object.keys(p.k).length; });
    var mains = function (pk) { return Object.keys(defs || {}).filter(function (c) { return defs[c].pack === pk && defs[c].main; }).sort(); };
    return '<div class="card"><h2>疾病面向小倍數：主顯 3 項（過程／結果／安全平衡）</h2><div class="note">區間分子／分母合計；分母不足 ' + (S.boot.settings.minN || 10) + ' 顯示 n。標「監測」者為非藥師可控之結果，只供觀察不作績效。</div><div class="smgrid">' +
      dz.map(function (p) {
        var ks = mains(p.code);
        return '<section class="sm"><h3><button type="button" class="linkbtn" data-goPack="' + esc(p.code) + '">' + esc(p.name) + '</button></h3><div class="note">' + p.n + ' 人次' + (p.tAch !== null && p.tAch !== undefined ? '｜目標達成 ' + p.tAch + '%' : '') + (p.period === '季' ? '｜季判讀' : '') + '</div>' +
          (ks.length ? ks.map(function (c) {
            var k = p.k[c.split('-')[1]], d = defs[c], nm = d.name.replace(/^[^：]+：/, '');
            var v = !k ? '<span class="note">無資料</span>' : k.small ? '<span class="small-n">n' + k.den + '</span>' : k.rate + '%';
            return '<div class="smrow"><span class="smn">' + esc(nm) + (d.nature && d.nature !== '績效' ? ' <span class="tag">' + esc(d.nature) + '</span>' : '') + '</span><span class="smbar"><span style="width:' + (k && k.rate !== null ? k.rate : 0) + '%"></span></span><span class="smv">' + v + '</span></div>';
          }).join('') : '<div class="note">尚未設定主顯指標</div>') + '</section>';
      }).join('') + '</div>' + (none.length ? '<div class="note">本區間無紀錄：' + esc(none.map(function (p) { return p.name; }).join('、')) + '</div>' : '') + '</div>';
  }
  /** 服務線看板（D10）：不計入疾病 KPI 與目標 */
  function serviceLines(ps, R) {
    var sl = ps.filter(function (p) { return p.cls === '服務線' || p.cls === '歷史'; });
    if (!sl.length) return '<div class="card"><h2>服務線（不計入疾病面向 KPI 與目標達成）</h2><div class="empty">本區間無服務線紀錄</div></div>';
    return '<div class="card"><h2>服務線（不計入疾病面向 KPI 與目標達成）</h2><div class="tablewrap"><table class="t"><thead><tr><th>服務線</th><th>人次</th><th>紀錄筆數</th><th>對前一等長區間</th><th>逐月人次</th></tr></thead><tbody>' +
      sl.map(function (p) {
        var x = { m: {} }; Object.keys(p.m).forEach(function (m) { x.m[m] = { num: p.m[m].n || 0 }; });
        return '<tr' + (p.hist ? ' class="hist"' : '') + '><td><button type="button" class="linkbtn" data-goPack="' + esc(p.code) + '">' + esc(p.name) + '</button>' + (p.hist ? '<span class="tag">歷史</span>' : '') + '</td><td class="num">' + p.n + '</td><td class="num">' + p.rec + '</td><td>' + deltaN(p.n, p.nPrev) + '</td><td>' + trendSvg(x, R.months.slice(-24), 'n', R.cut, 160) + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  }
  /** 全部指標（區間版）：依類型分組；分母不足收合；每列可展開定義 */
  function indicatorListRange(rows, R, defs, pk) {
    var B = byCodeOf(rows.filter(function (r) { return r.code !== 'U1'; }));
    if (!B.order.length) return indicatorList([], R.to, defs, pk);
    var types = ['結果', '過程', '平衡', '結構'];
    var item = function (c) {
      var x = B.by[c], cur = aggRange(x, R.months), prev = aggRange(x, R.prev), d = (defs || {})[c] || {};
      var val = !cur ? '<span class="note">本區間無資料</span>' : cur.small ? '<span class="note">n＝' + cur.den + '，樣本不足</span>' : cur.rate !== null ? '<b>' + cur.rate + '%</b><span class="note">　' + cur.num + '／' + cur.den + '</span>' :
        cur.median !== null && !cur.hasDen ? '<b>中位數 ' + cur.median + '</b><span class="note">（最近月）</span>' : '<b>' + cur.num + '</b>';
      return '<details class="ind"><summary><span class="iname">' + esc(x.name) + (d.main ? ' <span class="tag main">主顯</span>' : '') + (d.nature && d.nature !== '績效' ? ' <span class="tag">' + esc(d.nature) + '</span>' : '') + '</span><span class="ival">' + val + '</span>' +
        gapBar(cur && cur.rate, null, cur && cur.small) + '<span class="itr">' + (cur && cur.rate !== null ? deltaPP(cur, prev) : '') + trendSvg(x, R.months.slice(-24), cur && cur.hasDen ? 'rate' : 'n', R.cut, 130) + '</span></summary>' + defHtml(c, defs) + (d.ver ? '<div class="note">' + esc(d.ver) + '</div>' : '') + '</details>';
    };
    var isSmall = function (c) { var a = aggRange(B.by[c], R.months); return !a || a.small; };
    var big = B.order.filter(function (c) { return !isSmall(c); }), small = B.order.filter(isSmall);
    var out = types.map(function (t) { var list = big.filter(function (c) { return B.by[c].type === t; }); return list.length ? '<h3 class="itype">' + t + '指標</h3><div class="ilist">' + list.map(item).join('') + '</div>' : ''; }).join('');
    return (out || '<div class="empty">本區間所有指標樣本不足</div>') + (small.length ? '<details class="sub"><summary>樣本不足或本區間無資料（' + small.length + '）</summary><div class="ilist">' + small.map(item).join('') + '</div></details>' : '');
  }
  /** 病人來源分布（R4）：區間人次依來源；點選即切換來源篩選 */
  function sourceSplit(d) {
    var ss = d.srcSplit || {}, ks = Object.keys(ss).filter(function (k) { return ss[k] > 0; }).sort(function (a, b) { return ss[b] - ss[a]; });
    var tot = ks.reduce(function (a, k) { return a + ss[k]; }, 0);
    if (!tot) return '<div class="card"><h2>病人來源分布</h2><div class="empty">本區間無資料</div></div>';
    return '<div class="card"><h2>病人來源分布</h2><div class="note">區間人次依病人來源；點來源名稱即以該來源篩選全頁。</div><div class="srcbar" role="img" aria-label="' + esc(ks.map(function (k) { return (SRC_TXT[k] || k) + ' ' + ss[k]; }).join('、')) + '">' +
      ks.map(function (k, i) { return '<span class="sb' + (i % 4) + '" style="flex:' + ss[k] + '"></span>'; }).join('') + '</div><ul class="srclist">' +
      ks.map(function (k, i) { return '<li><span class="sw sb' + (i % 4) + '"></span><button type="button" class="linkbtn" data-src="' + esc(k) + '">' + esc(SRC_TXT[k] || k) + '</button> <b>' + ss[k] + '</b><span class="note">（' + Math.round(ss[k] / tot * 1000) / 10 + '%）</span></li>'; }).join('') + '</ul></div>';
  }
  function viewDashboard(view) {
    var nowYm = today().slice(0, 7);
    var U = S.boot.user || {}, lvN = { L1: 1, L2: 2, L3: 3, L4: 4 }[U.level] || 1;
    var tabs = U.learner === 'UGY' ? [['LRN', '學習歷程']] : [['DEPT', '科總覽'], ['PACK', '照護面向'], ['ME', '本人']]
      .concat(U.learner === 'PGY' || U.learner === 'TCH' || lvN >= 2 ? [['LRN', '學習歷程']] : [])
      .concat(lvN >= 2 ? [['TRAINEE', '同仁']] : []).concat([['KANBAN', '改善看板'], ['DQ', '資料品質'], ['DEV', '裝置與藥品']]);
    var V = S.dashView && tabs.some(function (t) { return t[0] === S.dashView; }) ? S.dashView : tabs[0][0];
    if (!S.dashQuick && !S.dashFrom) S.dashQuick = 'R12';
    view.innerHTML = '<div class="card no-print"><h2>成效儀表板</h2><div class="seg" role="tablist" aria-label="儀表板視圖">' +
      tabs.map(function (x) { return '<button type="button" role="tab" aria-selected="' + (V === x[0]) + '" data-view="' + x[0] + '" class="' + (V === x[0] ? 'on' : '') + '">' + x[1] + '</button>'; }).join('') +
      '</div><div class="filters"><div class="row three"><div><label class="f" for="dfrom">起始月份</label><select id="dfrom"></select></div><div><label class="f" for="dto">結束月份</label><select id="dto"></select></div>' +
      '<div><label class="f" for="dsrc">病人來源</label><select id="dsrc"><option value="ALL">全部來源</option></select></div></div>' +
      '<div class="seg quick" role="group" aria-label="快選區間">' + QUICK.map(function (q) { return '<button type="button" data-quick="' + q[0] + '" class="' + (S.dashQuick === q[0] ? 'on' : '') + '">' + q[1] + '</button>'; }).join('') + '</div>' +
      '<div id="dpWrap"><label class="f" for="dp" id="dpl">項目</label><select id="dp"></select></div></div>' +
      '<div class="actions-bar left"><button type="button" class="btn small ghost" id="dPrint">列印／存 PDF</button><button type="button" class="btn small ghost hidden" id="dCsv">下載 CSV</button></div>' +
      '<div class="note" id="dlast" role="status" aria-live="polite"></div></div><div id="dres"><div class="empty">載入中…</div></div>';
    var fillMonths = function (minYm) {
      var ms = [], m = nowYm, lo = minYm && minYm < ymShift(nowYm, -23) ? minYm : ymShift(nowYm, -23);
      while (m >= lo && ms.length < 240) { ms.push(m); m = ymShift(m, -1); }
      var opts = ms.map(function (x) { return '<option>' + x + '</option>'; }).join('');
      $('#dfrom').innerHTML = opts; $('#dto').innerHTML = opts;
      var r = S.dashQuick ? quickRange(S.dashQuick, nowYm, minYm) : { from: S.dashFrom, to: S.dashTo };
      if (r.from < lo) r.from = lo;
      $('#dfrom').value = r.from; $('#dto').value = r.to;
    };
    fillMonths(S.dashMinYm);
    var range = function () {
      var f = $('#dfrom').value, t = $('#dto').value;
      if (f > t) { var z = f; f = t; t = z; }
      var months = ymSeq(f, t), L = months.length;
      return { from: f, to: t, months: months, prev: ymSeq(ymShift(f, -L), ymShift(f, -1)), cut: S.boot.settings.spcCut || '2026-11', src: $('#dsrc').value || 'ALL' };
    };
    $$('[data-view]', view).forEach(function (b) { b.addEventListener('click', function () { S.dashView = b.getAttribute('data-view'); S.dashKey = ''; route(); }); });
    $$('[data-quick]', view).forEach(function (b) { b.addEventListener('click', function () {
      S.dashQuick = b.getAttribute('data-quick'); $$('[data-quick]', view).forEach(function (x) { x.classList.toggle('on', x === b); });
      var r = quickRange(S.dashQuick, nowYm, S.dashMinYm); $('#dfrom').value = r.from; $('#dto').value = r.to; load(); }); });
    ['#dfrom', '#dto'].forEach(function (s) { $(s).addEventListener('change', function () { S.dashQuick = ''; $$('[data-quick]', view).forEach(function (x) { x.classList.remove('on'); }); load(); }); });
    $('#dsrc').addEventListener('change', function () { S.dashSrc = this.value; load(); });
    $('#dPrint').addEventListener('click', function () {
      document.body.classList.add('print-dash');
      $$('details.ind, details.sub', $('#dres')).forEach(function (x) { x.open = true; });
      window.print();
      setTimeout(function () { document.body.classList.remove('print-dash'); }, 500);
    });
    var lastRows = [];
    $('#dCsv').addEventListener('click', function () { var R = range(); csvDownload('成效指標_' + (S.dashPack || 'ALL') + '_' + R.src + '_' + R.from + '_' + R.to + '.csv', lastRows); });
    var foot = function (d) {
      $('#dlast').textContent = '最後彙總：' + (d.lastRun || '尚未執行') + '。計數規則 ' + (d.countRule || '—') + '：面向人次＝同病人同日同面向計 1；整體人次＝同病人同日計 1；紀錄筆數另列為工作量。卡片為區間內分子／分母合計，並與前一等長區間比較；分母低於 ' + S.boot.settings.minN + ' 不顯示比率。已排除測試病歷號。';
      if (d.minYm && d.minYm !== S.dashMinYm) { S.dashMinYm = d.minYm; var f = $('#dfrom').value, t = $('#dto').value; fillMonths(d.minYm); if (!S.dashQuick) { $('#dfrom').value = f; $('#dto').value = t; } }
      if (d.sources) {
        var cur = S.dashSrc || 'ALL';
        $('#dsrc').innerHTML = ['ALL'].concat(d.sources).map(function (s) { return '<option value="' + esc(s) + '"' + (s === cur ? ' selected' : '') + '>' + esc(SRC_TXT[s] || s) + '</option>'; }).join('');
      }
    };
    var err = function (e) { $('#dres').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; };
    var bindCommon = function () {
      $$('[data-goPack]', $('#dres')).forEach(function (b) { b.addEventListener('click', function () { S.dashView = 'PACK'; S.dashPack = b.getAttribute('data-goPack'); route(); }); });
      $$('[data-src]', $('#dres')).forEach(function (b) { b.addEventListener('click', function () { S.dashSrc = b.getAttribute('data-src'); $('#dsrc').value = S.dashSrc; load(); }); });
      $$('[data-widen]', $('#dres')).forEach(function (b) { b.addEventListener('click', function () { S.dashQuick = 'ALLT'; route(); }); });
      if ($('#spcBase')) $('#spcBase').addEventListener('change', function () { S.spcBase = this.value; load(); });
    };
    var load = function () {
      var R = range(), sel = $('#dp'), ym = R.to, from = R.from;
      S.dashFrom = R.from; S.dashTo = R.to;
      $('#dCsv').classList.toggle('hidden', !(V === 'DEPT' || V === 'PACK'));
      if (V === 'DEPT' || V === 'PACK') {
        $('#dpWrap').classList.toggle('hidden', V === 'DEPT');
        var pk = V === 'DEPT' ? 'ALL' : (sel.value && sel.value !== 'ALL' ? sel.value : (S.dashPack && S.dashPack !== 'ALL' ? S.dashPack : ''));
        var base = V === 'PACK' ? 'r24' : (S.spcBase || 'r24');
        Promise.all([vapi('dashboard', { pack: pk || 'ALL', from: R.from, to: R.to, src: R.src }), vapi('insight', { pack: pk || 'ALL', base: base }).catch(function () { return null; })]).then(function (dd) {
          var d = dd[0], ins = dd[1];
          if (V === 'PACK' && !pk) ins = null;
          var seen = {}, packs = (S.boot.packs || []).filter(function (p) { return p.code && !seen[p.code] && (seen[p.code] = 1); }).map(function (p) { return { code: p.code, name: p.name }; });
          d.packs.forEach(function (p) { if (p.code !== 'ALL' && !seen[p.code]) { seen[p.code] = 1; packs.push(p); } });
          if (V === 'PACK') {
            sel.innerHTML = packs.map(function (p) { return '<option value="' + esc(p.code) + '">' + esc(p.name) + '</option>'; }).join('');
            if (!pk) { if (!packs.length) { $('#dres').innerHTML = '<div class="empty">尚無面向資料</div>'; return; } S.dashPack = packs[0].code; sel.value = S.dashPack; return load(); }
            S.dashPack = pk; sel.value = pk;
          } else S.dashPack = 'ALL';
          foot(d); lastRows = d.rows.filter(function (r) { return r.ym >= R.from && r.ym <= R.to; });
          var B = byCodeOf(d.rows), g = function (c) { return B.by[c]; };
          var rangeTxt = R.from + '～' + R.to + '（' + R.months.length + ' 個月）｜' + (SRC_TXT[R.src] || R.src);
          var c1 = g('C1'), c0 = g('C0'), a1 = aggRange(c1, R.months) || { num: 0 }, p1 = aggRange(c1, R.prev), a0 = aggRange(c0, R.months) || { num: 0 };
          var uq = null; Object.keys(d.uniq || {}).forEach(function (k) { var u = d.uniq[k]; if (u.from === R.from && u.to === R.to) uq = u; });
          var nCard = function (title) {
            return '<div class="dcard kcard2"><div class="dk">' + esc(title) + '</div><div class="big">' + a1.num + '</div><div class="ds">' + (uq ? '不重複病人 ' + uq.patients + '　' : '<span class="note">不重複病人：快選區間提供</span>　') + '紀錄筆數 ' + a0.num + '</div>' +
              '<div class="dfoot">' + deltaN(a1.num, p1 ? p1.num : 0) + trendSvg(c1, R.months, 'n', R.cut) + '</div></div>';
          };
          var html = '<div class="print-head">' + esc(S.boot.settings.hospital || '') + '　' + esc(rangeTxt) + '（列印 ' + today() + '）</div>' + checksumLine(ins);
          if (V === 'DEPT') {
            var dz = (d.packSummary || []).filter(function (p) { return p.cls === '疾病' || p.cls === '跨職類'; });
            var tN = 0, tD = 0; dz.forEach(function (p) { if (p.tDen) { tN += p.tNum; tD += p.tDen; } });
            var tCard = '<div class="dcard kcard2"><div class="dk">疾病面向目標達成</div><div class="big">' + (tD ? Math.round(tN / tD * 1000) / 10 + '%' : '—') + '</div><div class="ds">' + (tD ? tN + '／' + tD + ' 人次（新平台月份；服務線不計）' : '區間內無新平台月份或未設目標') + '</div><div class="dfoot"><span class="note">目標唯一來源＝疾病包登錄</span></div></div>';
            html += '<div class="dcards kpi8">' + nCard('整體人次（同病人同日計 1）') + tCard +
              kpiCard('教回完全理解（最終）', g('C3'), R, '排除無法應答') + kpiCard('不當用藥行為發現', g('M1'), R, '新平台紀錄') +
              kpiCard('介入接受', g('M2'), R, '病人接受藥師建議') + kpiCard('追蹤準時完成', g('G5'), R, '到期後 7 日內') +
              kpiCard('核心藥未自行中斷', g('G1'), R, '追蹤完成者') + kpiCard('30 日同題重複諮詢', g('B1'), R, '不同日；越低越好', { lowGood: true }) + '</div>' +
              '<div class="row two dash2">' + funnelHtml(g, R) + sourceSplit(d) + '</div>' +
              heatmapHtml(d.packSummary || [], R) + smallMultiples(d.packSummary || [], d.defs, R) + serviceLines(d.packSummary || [], R);
          } else {
            var title = (sel.options[sel.selectedIndex] || {}).text || '', meta = (d.packs || []).filter(function (p) { return p.code === pk; })[0] || {};
            var t1 = g('T1'), tN2 = 0, tD2 = 0;
            if (t1) R.months.forEach(function (m) { var r = t1.m[m]; if (r && m >= R.cut && r.target) { tN2 += r.num || 0; tD2 += r.target; } });
            var mains = Object.keys(d.defs || {}).filter(function (c) { return d.defs[c].pack === pk && d.defs[c].main; }).sort();
            var others = Object.keys(d.defs || {}).filter(function (c) { return d.defs[c].pack === pk && /-K\d$/.test(c) && !d.defs[c].main; }).sort();
            html += '<div class="card packhead"><h2>' + esc(title) + '</h2><div class="note">' + esc(rangeTxt) + (meta.cls === '服務線' ? '｜服務線：不計入疾病 KPI 與目標達成' : '') + (meta.period === '季' ? '｜低量面向：請以季或累計判讀，單月比率不具意義' : '') + (meta.pharm === false ? '｜跨職類照護：藥師非主責，以下不作藥師績效' : '') + '</div></div>' +
              '<div class="dcards">' + nCard('面向人次（同病人同日計 1）') +
              (tD2 ? '<div class="dcard kcard2"><div class="dk">目標達成</div><div class="big">' + Math.round(tN2 / tD2 * 1000) / 10 + '%</div><div class="ds">' + tN2 + '／' + tD2 + ' 人次（新平台月份）</div><div class="dfoot"><span class="note">含次面向與藥品唯一歸因</span></div></div>' : '') +
              kpiCard('教回完全理解（最終）', g('C3'), R, '') +
              mains.map(function (c) { return kpiCard(d.defs[c].name.replace(/^[^：]+：/, ''), g(c), R, d.defs[c].type, { tag: d.defs[c].nature !== '績效' ? d.defs[c].nature : '主顯', lowGood: /K5$/.test(c) }); }).join('') + '</div>' +
              (others.length ? '<details class="card sub"><summary><h2>其餘面向指標（' + others.length + '）</h2></summary><div class="dcards">' + others.map(function (c) { return kpiCard(d.defs[c].name.replace(/^[^：]+：/, ''), g(c), R, d.defs[c].type, { tag: d.defs[c].nature !== '績效' ? d.defs[c].nature : '', lowGood: /K5$/.test(c) }); }).join('') + '</div></details>' : '') +
              funnelHtml(g, R);
          }
          var people = {}; (d.person || []).forEach(function (p) { var k = p.name + '|' + p.pack; var o = people[k] = people[k] || { name: p.name, pack: p.packName || p.pack, n: 0, ep: 0, due: 0, done: 0 }; o.n += p.n; o.ep += p.ep; o.due += p.due; o.done += p.done; });
          var pl = Object.keys(people).map(function (k) { return people[k]; }).sort(function (a, b) { return a.name < b.name ? -1 : 1; });
          var ptable = d.level >= 2 && pl.length ? '<details class="card sub"><summary><h2>單位工作量（區間合計，依姓名排序，非排名）</h2></summary><div class="tablewrap"><table class="t"><thead><tr><th>人員</th><th>面向</th><th>人次</th><th>紀錄筆數</th><th>追蹤到期</th><th>追蹤完成</th></tr></thead><tbody>' +
            pl.map(function (p) { return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.pack) + '</td><td class="num">' + p.ep + '</td><td class="num">' + p.n + '</td><td class="num">' + p.due + '</td><td class="num">' + p.done + '</td></tr>'; }).join('') +
            '</tbody></table></div></details>' : '';
          $('#dres').innerHTML = html + (ins ? spcPanel(ins.spc, base, V === 'PACK') : '') + yearsTable(d.years, pk || 'ALL') +
            '<div class="card"><h2>' + esc(V === 'DEPT' ? '科總覽' : (sel.options[sel.selectedIndex] || {}).text || '') + '：全部指標（' + esc(R.from + '～' + R.to) + '）</h2>' + indicatorListRange(d.rows, R, d.defs, pk || 'ALL') + '</div>' + ptable;
          bindCommon();
          $('#dlast').textContent += '　已更新 ' + B.order.length + ' 項指標。';
        }).catch(err);
      } else if (V === 'LRN') {
        vapi('insight', { pack: 'ALL', base: 'r24' }).then(function (ins) {
          var ids = {}, people = [];
          ins.learners.forEach(function (r) { if (!ids[r.pid] && (r.type === 'PGY' || r.type === 'UGY' || r.self)) { ids[r.pid] = 1; people.push(r); } });
          $('#dpl').textContent = '學習者（可檢視者）';
          sel.innerHTML = people.map(function (p) { return '<option value="' + esc(p.pid) + '">' + esc(p.name + '｜' + (p.type === 'UGY' ? 'UGY 學生' : p.type === 'PGY' ? 'PGY 學員' : p.type) + (p.self ? '（本人）' : '')) + '</option>'; }).join('');
          $('#dpWrap').classList.toggle('hidden', people.length < 2);
          if (S.dashKey && ids[S.dashKey]) sel.value = S.dashKey;
          S.dashKey = sel.value;
          $('#dlast').textContent = '最後彙總：' + (ins.lastRun || '尚未執行') + '。學習歷程自授權名單「到職日」起累計（不受上方區間篩選）；人次＝同病人同日同面向計 1；PGY／UGY 只能看本人，臨床教師與管理者可看全部。';
          $('#dres').innerHTML = checksumLine(ins) + '<div class="card"><h2>學習歷程</h2>' + (people.length ? learnerPanel(ins.learners, sel.value) : '<div class="empty">尚無可檢視的學習者紀錄</div>') + '</div>';
        }).catch(err);
      } else if (V === 'KANBAN') {
        $('#dpWrap').classList.add('hidden');
        var drawK = function (d) {
          $('#dres').innerHTML = kanbanHtml(d);
          $$('[data-kb]', $('#dres')).forEach(function (f) {
            f.addEventListener('submit', function (e) {
              e.preventDefault();
              var b = f.querySelector('button'); b.disabled = true;
              vapi('kanban', { id: f.getAttribute('data-kb'), status: f.status.value, owner: f.owner.value, cause: f.cause.value, pdsa: f.pdsa.value })
                .then(function (d2) { toast('已更新看板卡片'); drawK(d2); }, function (e2) { b.disabled = false; toast(e2.message, 'err'); });
            });
          });
        };
        vapi('kanban', {}).then(drawK).catch(err);
      } else if (V === 'DQ') {
        $('#dpWrap').classList.add('hidden');
        vapi('insight', { pack: 'ALL', base: 'r24' }).then(function (ins) {
          $('#dlast').textContent = '最後彙總：' + (ins.lastRun || '尚未執行') + '。';
          $('#dres').innerHTML = checksumLine(ins) + dqPanel(ins.dq);
        }).catch(err);
      } else if (V === 'ME' || V === 'TRAINEE') {
        vapi('dashboard', { pack: 'ALL', from: R.from, to: R.to, src: 'ALL' }).then(function (d) {
          foot(d);
          var people = d.people || [];
          if (V === 'TRAINEE') {
            $('#dpl').textContent = '同仁（可檢視者）';
            sel.innerHTML = people.map(function (p) { return '<option value="' + esc(p.pid) + '">' + esc(p.name + (p.self ? '（本人）' : '')) + '</option>'; }).join('');
            if (S.dashKey && people.some(function (p) { return p.pid === S.dashKey; })) sel.value = S.dashKey;
            S.dashKey = sel.value;
          } else $('#dpWrap').classList.add('hidden');
          var who = V === 'ME' ? people.filter(function (p) { return p.self; })[0] : people.filter(function (p) { return p.pid === sel.value; })[0];
          if (!who) { $('#dres').innerHTML = '<div class="empty">' + (V === 'ME' ? '所選區間尚無您的紀錄' : '沒有可檢視的同仁資料') + '</div>'; return; }
          var tot = {}; who.months.forEach(function (m) { Object.keys(m).forEach(function (k) { if (typeof m[k] === 'number') tot[k] = (tot[k] || 0) + m[k]; }); });
          var epCard = '<div class="dcard"><div class="dk">人次（同病人同日同面向計 1）</div><div class="big">' + (tot['人次'] || 0) + '</div><div class="ds">紀錄筆數 ' + (tot['件數'] || 0) + '（工作量）</div></div>';
          var cards = epCard + d.metrics.map(function (m) {
            var own = tot[m[3]] >= 1 ? pct(tot[m[2]] || 0, tot[m[3]]) : null, few = (tot[m[3]] || 0) < 5;
            return '<div class="dcard"><div class="dk">' + esc(m[1]) + '</div><div class="big">' + (own === null ? '—' : few ? '<span class="small-n">樣本少（n＝' + tot[m[3]] + '）</span>' : own + '%') + '</div><div class="ds">區間 ' + (tot[m[2]] || 0) + '／' + (tot[m[3]] || 0) + '</div><div class="dfoot">' + band(d.dist[m[0]], few ? null : own) + '</div></div>';
          }).join('');
          var sup = function (m) { var a = m['督導_獨立'] || 0, b = m['督導_在場'] || 0, c = m['督導_覆核'] || 0, t = a + b + c; return { a: a, b: b, c: c, t: t }; };
          var months = R.months.map(function (m) { return who.months.filter(function (x) { return x.ym === m; })[0] || { ym: m }; });
          var trend = '<div class="tablewrap"><table class="t"><thead><tr><th>月份</th><th>人次</th><th>紀錄筆數</th><th>教回完全</th><th>發現問題或不當行為</th><th>介入接受</th><th>追蹤準時</th><th>督導（獨立／在場／覆核）</th><th>填寫秒數中位數</th></tr></thead><tbody>' +
            months.filter(function (m) { return m['件數'] || m['追蹤到期數']; }).reverse().map(function (m) {
              var s2 = sup(m), r = function (a, b) { return b ? pct(a || 0, b) + '%<span class="note">　' + (a || 0) + '／' + b + '</span>' : '—'; };
              return '<tr><td>' + esc(m.ym) + '</td><td class="num">' + (m['人次'] || 0) + '</td><td class="num">' + (m['件數'] || 0) + '</td><td>' + r(m['教回完全'], m['教回分母']) + '</td><td>' + r(m['發現件數'], m['件數']) + '</td><td>' + r(m['介入接受'], m['介入分母']) +
                '</td><td>' + r(m['追蹤準時'], m['追蹤到期數']) + '</td><td>' + (s2.t ? '<span class="stack" role="img" aria-label="' + esc('獨立 ' + s2.a + '、在場 ' + s2.b + '、覆核 ' + s2.c) + '"><span class="s1" style="flex:' + s2.a + '"></span><span class="s2" style="flex:' + s2.b + '"></span><span class="s3" style="flex:' + s2.c + '"></span></span> ' + s2.a + '／' + s2.b + '／' + s2.c : '—') +
                '</td><td class="num">' + (m.secMed === null || m.secMed === undefined ? '—' : m.secMed) + '</td></tr>';
            }).join('') + '</tbody></table></div>';
          var st = sup(tot);
          $('#dres').innerHTML = '<div class="print-head">' + esc(S.boot.settings.hospital || '') + '　' + (V === 'ME' ? '藥師個人成效' : '學習護照：' + esc(who.name)) + '　' + esc(R.from) + '～' + esc(R.to) + '（列印 ' + today() + '）</div>' +
            '<div class="card"><h2>' + (V === 'ME' ? '我的成效' : esc(who.name)) + '（' + esc(R.from + '～' + R.to) + '）</h2><div class="note">藍點＝' + (V === 'ME' ? '本人' : '此同仁') + '；灰帶＝科內四分位區間；直線＝中位數。分布只含區間分母 ≥5 的同仁，不顯示姓名、不排名。</div>' +
            '<div class="dcards">' + cards + '</div></div>' +
            (V === 'TRAINEE' ? '<div class="card"><h2>督導方式累計</h2><div class="ds">獨立 ' + st.a + '　教師在場 ' + st.b + '　教師事後覆核 ' + st.c +
              (st.t ? '　（獨立占 ' + pct(st.a, st.t) + '%，可作信任等級之參考，非判定）' : '　（尚無督導方式紀錄）') + '</div></div>' : '') +
            '<div class="card"><h2>逐月明細</h2>' + trend + '</div>';
        }).catch(err);
      } else {
        $('#dpWrap').classList.remove('hidden');
        var dim = S.dashDim || 'DEVICE';
        $('#dpl').innerHTML = '<select id="ddim" aria-label="維度">' + [['DEVICE', '裝置類型'], ['DRUG', '藥品'], ['ATC', '藥品類別（ATC 4 碼）']].map(function (x) { return '<option value="' + x[0] + '"' + (dim === x[0] ? ' selected' : '') + '>' + x[1] + '</option>'; }).join('') + '</select>';
        $('#ddim').addEventListener('change', function () { S.dashDim = this.value; S.dashKey = ''; load(); });
        S.dashKey = sel.value || S.dashKey || '';
        vapi('dashDrug', { dim: dim, key: S.dashKey, from: from, to: ym }).then(function (d) {
          if (!d.keys.length) { $('#dres').innerHTML = '<div class="empty">尚無技巧評估資料</div>'; sel.innerHTML = ''; return; }
          sel.innerHTML = d.keys.map(function (k) { return '<option value="' + esc(k.key) + '">' + esc(k.name || k.key) + '（' + k.n + ' 次）</option>'; }).join('');
          if (!d.key) { S.dashKey = d.keys[0].key; return load(); }
          sel.value = d.key;
          $('#dlast').textContent = '最後彙總：' + (d.lastRun || '尚未執行') + '。D 指標以技巧評估為單位；分母低於 ' + S.boot.settings.minN + ' 時不顯示比率。';
          $('#dres').innerHTML = '<div class="card"><h2>' + esc(sel.options[sel.selectedIndex].text) + '</h2>' + indicatorListRange(d.rows, R, {}) + '</div>';
        }).catch(err);
      }
    };
    $('#dp').addEventListener('change', function () { if (V === 'TRAINEE' || V === 'DEV' || V === 'LRN') S.dashKey = this.value; load(); });
    load();
  }

  start();
})();
