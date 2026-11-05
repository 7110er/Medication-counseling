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
      packs: d[7] ? d[7].split(',') : [], avoid: d[8] ? d[8].split(',') : [] };
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
    var staff = (c.staff || []).map(function (x) {
      return '<div class="cfh">' + esc(x.layer) + (x.draft ? ' <span class="tag">草稿</span>' : '') + '</div><div class="pre">' + esc(x.text) + '</div>';
    }).join('');
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
    view.innerHTML = statusBar(b) +
      '<div class="card hero"><label class="f" for="hq">病歷號、藥名、成分、處置代碼或簡碼、照護面向</label>' +
      '<div class="inline"><input type="search" id="hq" autocomplete="off" spellcheck="false" placeholder="例：A1234567、Symbicort、metformin、糖尿病">' +
      '<button type="button" class="btn ghost" id="hfree">不選藥直接記錄</button></div>' +
      '<div id="hqres"></div></div>' +
      '<div class="card"><h2>今日要做</h2><div id="htasks" class="sk"><div class="skel"></div><div class="skel"></div></div></div>' +
      '<div class="card"><h2>近 7 日我照護的病人</h2><div id="hrecent" class="sk"><div class="skel"></div><div class="skel"></div></div></div>' +
      '<div class="grid2"><div class="card"><h2>本月我的成效</h2><div id="hmonth" class="sk"><div class="skel"></div></div></div>' +
      '<div class="card"><h2>內容可信度</h2><div class="kpis"><div><b>' + (st.liveCards || 0) + '</b><span>品項層已簽核藥品卡</span></div>' +
      '<div><b>' + (st.sourcesVerified || 0) + '／' + (st.sources || 0) + '</b><span>來源已查證</span></div>' +
      '<div><b>' + (st.qLive || 0) + '／' + (st.questions || 0) + '</b><span>題目可上線</span></div></div>' +
      '<div class="note">藥品內容依 ATC 類別繼承；每段標示層級與簽核狀態，草稿不會出現在病人版摘要。</div></div></div>' +
      '<div class="card"><h2>我常用</h2><div id="hfreq" class="sk"><div class="skel"></div></div></div>' +
      '<div class="status note" id="hstatus">版本 ' + esc(b.settings.version) + (b.settings.showDrafts ? '｜<span class="tag">人員端顯示未簽核內容</span>' : '') +
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
        '<div class="note">裝置技巧評估 ' + h.month.devices + ' 次，首次通過率 ' + (h.month.passRate === null ? '—' : h.month.passRate + '%') + '（' + h.month.judged + ' 次可判定）</div>' +
        '<div class="actions-bar"><a class="btn small ghost" href="#dashboard">看儀表板</a></div>';
      $('#hrecent').className = '';
      $('#hrecent').innerHTML = h.recent.length ? h.recent.map(function (r) {
        return '<div class="dres"><div class="dmain"><b>末四碼 ' + esc(r.last4) + '</b>　' + esc(r.packName) + ' <span class="note">' + esc(r.time) + '</span>' +
          (r.drugs.length ? '<div class="note">' + esc(r.drugs.map(function (d) { return d.brand; }).join('、')) + '</div>' : '') + '</div>' +
          '<button type="button" class="btn small ghost" data-sum="' + esc(r.recordId) + '">摘要</button>' +
          (r.drugs.length ? '<button type="button" class="btn small" data-again="' + esc(r.recordId) + '">同藥再指導</button>' : '') + '</div>';
      }).join('') : '<div class="empty">近 7 日沒有紀錄</div>';
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
      $('#hfreq').innerHTML = (h.topDrugs.length ? '<div class="group-label">常用藥品（近 30 日）</div><div class="chips">' + h.topDrugs.map(function (d) {
        return '<button type="button" class="chip" data-fd="' + esc(d.code) + '">' + esc(d.brand) + ' <span class="note">' + d.n + '</span></button>';
      }).join('') + '</div>' : '') + (h.topPacks.length ? '<div class="group-label">常用面向</div><div class="chips">' + h.topPacks.map(function (p) {
        return '<button type="button" class="chip" data-fp="' + esc(p.code) + '">' + esc(p.name) + ' <span class="note">' + p.n + '</span></button>';
      }).join('') + '</div>' : '') || '<div class="empty">累積紀錄後會顯示常用藥品與面向</div>';
      $$('[data-fd]', $('#hfreq')).forEach(function (bt) { bt.addEventListener('click', function () { startRecord({ drugs: [bt.getAttribute('data-fd')], entry: '藥' }); }); });
      $$('[data-fp]', $('#hfreq')).forEach(function (bt) { bt.addEventListener('click', function () { startRecord({ pack: bt.getAttribute('data-fp'), entry: '面向' }); }); });
      var items = t.followups.filter(function (f) { return f.due <= today(); }).map(function (f) { return taskItemHtml('fu', f); })
        .concat(t.referrals.map(function (x) { return taskItemHtml('ref', x); }));
      $('#htasks').className = '';
      $('#htasks').innerHTML = items.length ? '<ul class="tl">' + items.slice(0, 5).join('') + '</ul>' +
        '<div class="actions-bar"><a class="btn small ghost" href="#tasks">全部待辦（' + items.length + '）</a></div>' : '<div class="empty">今日沒有到期待辦</div>';
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
      '<div class="progress" id="prog" aria-label="填寫進度"><span data-step="1">病人</span><span data-step="2">藥品與技巧</span><span data-step="3">行為與後續</span></div>' +
      '<div class="card" data-sec="1"><h2>病人</h2><div class="row two">' +
      '<div data-field="mrn"><label class="f">病歷號 <span class="req">*</span></label><div class="inline"><input type="text" name="mrn" maxlength="20" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="btn small ghost" id="lastBtn" title="查詢此病人過去的指導結果（留存稽核）">上次指導</button></div><div id="lastNote"></div></div>' +
      '<div data-field="source"><label class="f">病人來源 <span class="req">*</span></label><select name="source"><option value="">請選擇</option>' + opt('病人來源') + '</select></div></div>' +
      (b.settings.branches.length ? '<label class="f">分院</label><select name="branch"><option value="">（本院）</option>' +
        b.settings.branches.map(function (x) { return '<option>' + esc(x) + '</option>'; }).join('') + '</select>' : '') + '</div>' +

      '<div class="card" data-sec="2"><h2>本次指導的藥品</h2>' +
      '<input type="search" name="dq" placeholder="輸入藥名、成分、處置代碼或簡碼（至少 2 字）" autocomplete="off" spellcheck="false">' +
      '<div id="dqres" class="dqres"></div><div id="drugList" class="druglist"><div class="note">未選藥品時可直接依面向題目紀錄</div></div>' +
      '<div id="avoidNote"></div></div>' +

      '<div class="card hidden" id="devCard" data-sec="2"><h2>裝置技巧評估</h2><div class="note">逐項觀察病人（或照顧者）實際操作：做到／沒做到／未評估。標 <b class="crit">關鍵</b> 者沒做到即判未通過。</div><div id="devList"></div></div>' +

      '<div class="card" data-sec="2"><h2>照護面向與標準回應</h2>' +
      '<div data-field="pack"><label class="f">主要照護面向 <span class="req">*</span></label><select name="pack">' + packOpts + '</select></div>' +
      '<div id="packNote"></div>' +
      '<details class="sub"><summary>合併面向（共病）</summary><div class="chips" id="packs2"></div></details>' +
      '<div class="row two"><div><label class="f">問題分類</label><select name="cat"><option value="">全部</option></select></div>' +
      '<div><label class="f">搜尋題目</label><input type="search" name="qsearch" placeholder="輸入關鍵字"></div></div>' +
      '<div class="qlist" id="qlist"><div class="empty">請先選擇主要照護面向</div></div>' +
      '<label class="f">病人提出的問題（可空白）</label><input type="text" name="question" maxlength="500">' +
      '<div data-field="response"><label class="f">醫療人員回應 <span class="req" id="respReq">*</span><span class="note" id="respHint"></span></label>' +
      '<div class="actions-bar left"><button type="button" class="btn small ghost hidden" id="cardFill">帶入藥品卡重點</button></div>' +
      '<textarea name="response" maxlength="5000" rows="7"></textarea><div class="note" id="respCount">0 / 5000</div></div></div>' +

      '<div class="card" data-sec="3"><h2>不當用藥行為與介入</h2><div class="note">本次發現病人實際的錯誤用藥行為才勾選；未發現則略過。</div>' +
      '<div class="chips" id="behaviors">' + codes('不當用藥行為').map(function (c) { return chip('behaviors', c.code, c.text); }).join('') + '</div>' +
      '<div id="misuseHint"></div>' +
      '<div id="ivBox" class="hidden" data-field="intervention"><label class="f">介入結果 <span class="req">*</span></label><div class="chips">' +
      codes('介入結果').map(function (c) { return chip('intervention', c.code, c.text, false, 'radio'); }).join('') + '</div></div></div>' +

      '<div class="card" data-sec="3"><h2>結果與後續</h2>' +
      '<div data-field="teachback"><label class="f">教回（teach-back）結果 <span class="req" id="tbReq">*</span><span class="note" id="tbHint"></span></label><div class="chips">' +
      codes('教回結果').map(function (c) { return chip('teachback', c.code, c.text, false, 'radio'); }).join('') + '</div></div>' +
      '<div id="tbPrompts"></div>' +
      '<div data-field="actions"><label class="f">病人行動計畫 <span class="req">*</span>（至少一項）</label><div class="chips" id="actions"><span class="note">請先選擇主要照護面向</span></div></div>' +
      '<div class="toggle"><input type="checkbox" name="caregiver" id="cg"><label for="cg">照顧者在場</label></div>' +
      '<div class="toggle"><input type="checkbox" name="needFu" id="nf"><label for="nf">需要追蹤</label> <span class="auto hidden" id="fuAuto">自動：因發現不當用藥行為建立追蹤，可取消</span></div>' +
      '<div class="row two" id="fuBox" style="display:none"><div><label class="f">幾天後追蹤</label><input type="number" name="fuDays" min="1" max="365" value="14"></div>' +
      '<div><label class="f">追蹤職類</label><select name="fuRole">' + roleOpts + '</select></div></div>' +
      '<div class="toggle"><input type="checkbox" name="needRef" id="nr"><label for="nr">建立轉介待辦</label></div>' +
      '<div id="refBox" style="display:none" data-field="refRoles"><label class="f">轉介給（可多選）</label><div class="chips">' +
      codes('職類').map(function (c) { return chip('refRoles', c.code, c.text); }).join('') + '</div></div></div>' +

      '<details class="card opt" id="optWhole"><summary><h2>全人評估（可略過）</h2></summary><label class="f">發現問題（可複選）</label>' +
      Object.keys(issueGroups).map(function (g) {
        return '<div class="group-label">' + esc(g) + '</div><div class="chips">' + issueGroups[g].map(function (c) { return chip('issues', c.code, c.text); }).join('') + '</div>';
      }).join('') +
      '<label class="f">跨職類照護需求（可複選）</label><div class="chips">' +
      codes('職類').map(function (c) { return chip('needs', c.code, c.text); }).join('') + '</div>' +
      '<label class="f">全人照護建議</label><textarea name="advice" maxlength="2000" rows="3"></textarea></details>' +

      '<details class="card opt" id="optFeedback"><summary><h2>病人回饋與簽名（可略過）</h2></summary>' +
      codes('滿意度題目').map(function (c, i) {
        var k = 's' + (i + 1);
        return '<div class="scale"><div>' + esc(c.text) + '</div><div class="opts">' + [1, 2, 3, 4, 5].map(function (n) {
          return '<label><input type="radio" name="' + k + '" value="' + n + '">' + n + '</label>';
        }).join('') + '<button type="button" class="btn ghost small" data-clear="' + k + '">清除</button></div></div>';
      }).join('') + '<div class="note">1＝非常不同意，5＝非常同意</div>' +
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
    f.addEventListener('input', function () { S.dirty = true; });
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
    f.needFu.addEventListener('change', function () { $('#fuBox', f).style.display = f.needFu.checked ? '' : 'none'; });
    f.needRef.addEventListener('change', function () {
      $('#refBox', f).style.display = f.needRef.checked ? '' : 'none';
      if (f.needRef.checked) vals(f, 'needs').forEach(function (r) { setChecked(f, 'refRoles', r, true); });
    });
    $$('[data-clear]', f).forEach(function (btn) {
      btn.addEventListener('click', function () { $$('input[name="' + btn.getAttribute('data-clear') + '"]', f).forEach(function (x) { x.checked = false; x.parentNode.classList.remove('on'); }); });
    });
    f.addEventListener('change', function (e) {
      var n = e.target.name;
      if (n && /^s[123]$/.test(n)) $$('input[name="' + n + '"]', f).forEach(function (x) { x.parentNode.classList.toggle('on', x.checked); });
      if (n === 'qpick') onQuestionPick(f);
      if (n === 'packs2') updateAvoid(f);
      if (n === 'behaviors') {
        var any = vals(f, 'behaviors').length > 0;
        $('#ivBox', f).classList.toggle('hidden', !any);
        if (any && !f.needFu.checked) { f.needFu.checked = true; $('#fuBox', f).style.display = ''; $('#fuAuto', f).classList.remove('hidden'); }
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
    // 預先帶入
    if (pre.mrn) f.mrn.value = pre.mrn;
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
  function onPackChange(f) {
    var code = f.pack.value;
    var p = S.boot.packs.filter(function (x) { return x.code === code; })[0];
    $('#packNote', f).innerHTML = (f.pack.dataset.auto === '1' ? '<div class="note">依藥品自動帶入，可修改</div>' : '') +
      (p && p.status === '過渡沿用' ? '<div class="msg info">此面向沿用舊版題庫，內容尚未完成來源複審；回應請依現行指引自行確認。</div>' : '');
    var keep = vals(f, 'packs2');
    $('#packs2', f).innerHTML = S.boot.allPacks.filter(function (x) { return x.code !== code; })
      .map(function (x) { return chip('packs2', x.code, x.name, keep.indexOf(x.code) >= 0); }).join('');
    var keepA = vals(f, 'actions');
    var acts = codes('行動計畫').filter(function (c) { return c.pack === code || c.pack === 'ALL'; });
    $('#actions', f).innerHTML = acts.length ? acts.map(function (c) { return chip('actions', c.code, c.text, keepA.indexOf(c.code) >= 0); }).join('') : '<span class="note">無選項</span>';
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
    $('#qlist', f).innerHTML = list.length ? list.map(function (q) {
      return '<div class="qitem"><input type="checkbox" name="qpick" value="' + esc(q.id) + '"' + (picked.indexOf(q.id) >= 0 ? ' checked' : '') +
        ' aria-label="選擇題目"><div class="q"><div>' + esc(q.q) + '</div><div class="meta">' +
        (q.tags.indexOf('REDFLAG') >= 0 ? ' <span class="tag bad">紅旗</span>' : '') +
        (q.att ? ' <button type="button" class="btn ghost small" data-att="' + esc(q.id) + '">附件</button>' : '') +
        '</div><details><summary>預覽回應</summary><div>' + esc(q.a) + '</div><div class="note">題目編號 ' + esc(q.id) + '</div>' +
        (q.staff ? '<div class="qstaff"><b>人員提示（不給病人）</b>\n' + esc(q.staff) + '</div>' : '') + '</details></div></div>';
    }).join('') : '<div class="empty">' + (qs.length ? '沒有符合的題目' : '此面向為自由記錄，請直接填寫回應') + '</div>';
    $$('[data-att]', f).forEach(function (btn) { btn.addEventListener('click', function () { showAttachment(btn.getAttribute('data-att')); }); });
  }

  function onQuestionPick(f) {
    var qs = S.qcache[f.pack.value] || [];
    var picked = vals(f, 'qpick');
    var text = qs.filter(function (q) { return picked.indexOf(q.id) >= 0; }).map(function (q) { return '【' + q.q + '】\n' + q.a; }).join('\n\n');
    if (f.response.value && f.response.dataset.auto !== f.response.value && !confirm('以勾選題目的標準回應覆蓋目前內容？')) return;
    f.response.value = text.slice(0, 5000);
    f.response.dataset.auto = f.response.value;
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
      advice: f.advice.value.trim(), teachback: radio(f, 'teachback'), actions: vals(f, 'actions'), caregiver: f.caregiver.checked,
      needFu: f.needFu.checked, fuDays: f.fuDays.value, fuRole: f.fuRole.value, needRef: f.needRef.checked,
      refRoles: vals(f, 'refRoles'), s1: radio(f, 's1'), s2: radio(f, 's2'), s3: radio(f, 's3'), signature: sig.data(),
      drugs: f._drugs.slice(),
      devices: activeDevices(f).map(function (c) {
        var st = f._dev[c];
        return { drug: c, kind: st.kind, methods: st.methods, results: st.results, errors: st.errors, aid: st.aid, operator: st.operator, verdict: st.verdict };
      }),
      behaviors: vals(f, 'behaviors'), intervention: radio(f, 'intervention'),
      entry: f.getAttribute('data-entry') || '面向',
      autoEdited: auto ? auto.trim() !== resp : undefined
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
    if (!r.teachback && !r.devices.length) add('teachback', '教回結果');
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
    var tick = function () { msg.innerHTML = '<div class="msg info submitting">已送出，寫入中（' + Math.round((Date.now() - t0) / 1000) + ' 秒）…請勿關閉或重按</div>'; };
    tick();
    var timer = setInterval(tick, 1000);
    var unlock = function () { clearInterval(timer); f.classList.remove('locked'); ctrls.forEach(function (x) { x.disabled = false; }); };
    api('submit', { record: r }).then(function (res) {
      unlock();
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
      (s.fuDue ? '<h3>下次追蹤</h3><p>我們將在 ' + esc(s.fuDue) + ' 前後與您聯繫或於回診時確認。</p>' : '') +
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
    var n = t.followups.filter(function (f) { return f.overdue || f.due <= today(); }).length + t.referrals.length;
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
      view.innerHTML =
        '<div class="card"><h2>追蹤（' + t.followups.length + '）</h2>' + (t.followups.length ? t.followups.map(function (f) {
          return '<form class="card" data-fu="' + esc(f.id) + '" data-beh="' + (f.hasBehaviors ? '1' : '') + '"><div><b>' + esc(f.packName) + '</b>　病歷號末四碼 ' + esc(f.last4) +
            '　<span class="' + (f.overdue ? 'overdue' : '') + '">到期 ' + esc(f.due) + (f.overdue ? '（逾期）' : '') + '</span>' +
            (f.mine ? ' <span class="tag ok">我建立</span>' : ' <span class="tag">' + esc(f.role) + '</span>') + '</div>' + ctxHtml(f.ctx) +
            '<div class="row two"><div><label class="f">追蹤結果</label><select name="result"><option value="">請選擇</option>' + resOpts + '</select></div>' +
            '<div><label class="f">說明</label><input type="text" name="note" maxlength="1000"></div></div>' +
            (f.hasBehaviors ? '<label class="f">上次發現的不當用藥行為是否仍持續？ <span class="req">*</span></label><div class="chips">' +
              chip('persist', 'N', '已改善', false, 'radio') + chip('persist', 'Y', '仍持續', false, 'radio') + '</div>' : '') +
            (f.outcomes.length ? '<label class="f">已確認之結果項目</label><div class="chips">' + f.outcomes.map(function (o) { return chip('outcomes', o.code, o.text); }).join('') + '</div>' : '') +
            '<div class="actions-bar"><button type="button" class="btn small ghost" data-redo="' + esc(f.pack) + '">再次指導</button><button class="btn small">完成追蹤</button></div></form>';
        }).join('') : '<div class="empty">沒有待辦追蹤</div>') + '</div>' +
        '<div class="card"><h2>轉介給我的職類（' + t.referrals.length + '）</h2>' + (t.referrals.length ? t.referrals.map(function (x) {
          return '<form class="card" data-ref="' + esc(x.id) + '"><div><b>' + esc(x.packName) + '</b>　病歷號末四碼 ' + esc(x.last4) +
            '　發出 ' + esc(x.sent) + '（第 ' + esc(x.days) + ' 天）' + (x.days > 7 ? ' <span class="tag bad">超過 7 天</span>' : '') + '</div>' + ctxHtml(x.ctx) +
            '<div class="row two"><div><label class="f">處理結果</label><select name="result"><option value="">請選擇</option>' + refOpts + '</select></div>' +
            '<div><label class="f">說明</label><input type="text" name="note" maxlength="1000"></div></div>' +
            '<div class="actions-bar"><button class="btn small">完成轉介</button></div></form>';
        }).join('') : '<div class="empty">沒有待受理轉介</div>') + '</div>';
      bindChips(view);
      $$('[data-redo]', view).forEach(function (bt) {
        bt.addEventListener('click', function () { var p = bt.getAttribute('data-redo'); startRecord({ pack: packLive(p) ? p : '', entry: '待辦' }); });
      });
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
          f.querySelector('button:not([type=button])').disabled = true;
          api('followup', { id: f.getAttribute('data-fu'), result: f.result.value, outcomes: vals(f, 'outcomes'), note: f.note.value, persist: persist })
            .then(function () { toast('已完成追蹤'); route(); refreshTaskBadge(); })
            .catch(function (er) { toast(er.message, 'err'); f.querySelector('button:not([type=button])').disabled = false; });
        });
      });
      $$('form[data-ref]', view).forEach(function (f) {
        f.addEventListener('submit', function (e) {
          e.preventDefault();
          if (!f.result.value) return toast('請選擇處理結果', 'err');
          f.querySelector('button').disabled = true;
          api('referral', { id: f.getAttribute('data-ref'), result: f.result.value, note: f.note.value })
            .then(function () { toast('已完成轉介'); route(); refreshTaskBadge(); })
            .catch(function (er) { toast(er.message, 'err'); f.querySelector('button').disabled = false; });
        });
      });
    }).catch(function (e) { view.innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
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
              (it.drugs && it.drugs.length ? '<button type="button" class="btn small" data-redo="' + esc(it.id) + '">同藥複評</button>' : '') + '</div></div>';
          }).join('') : '<div class="empty">無可檢視紀錄</div>') + '</div>';
        $('#hnew').addEventListener('click', function () { startRecord({ mrn: mrn, last: h.lastByDrug || {}, entry: '病人' }); });
        $$('[data-sum]', out).forEach(function (b) {
          b.addEventListener('click', function () {
            api('summary', { recordId: b.getAttribute('data-sum') }).then(showSummary).catch(function (er) { toast(er.message, 'err'); });
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

  /* ---------- 成效儀表板 ---------- */
  function ymShift(ym, n) { var y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1 + n; y += Math.floor(m / 12); m = ((m % 12) + 12) % 12; return y + '-' + (m < 9 ? '0' : '') + (m + 1); }
  function spark(points) {
    var w = 120, h = 30;
    var vs = points.filter(function (p) { return p !== null; });
    if (vs.length < 2) return '';
    var n = points.length;
    var d = '';
    points.forEach(function (v, i) {
      if (v === null) return;
      var x = (i / (n - 1)) * (w - 4) + 2, y = h - 2 - (v / 100) * (h - 4);
      d += (d && points[i - 1] !== null ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    });
    return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="近 12 個月趨勢"><path d="' + d + '" fill="none" stroke="#2f5d7c" stroke-width="1.6"/></svg>';
  }
  function cell(r) {
    if (!r) return '—';
    if (r.small) return r.num + '／' + r.den + ' <span class="tag">樣本不足</span>';
    if (r.rate === null) return (r.num === null ? '' : r.num) + (r.den !== null && r.den !== undefined ? '／' + r.den : '');
    return r.num + '／' + r.den + '　<b>' + r.rate + '%</b>' + (r.target !== null && r.target !== undefined ? (r.rate >= r.target ? ' <span class="tag ok">達標</span>' : ' <span class="tag bad">未達 ' + r.target + '%</span>') : '');
  }
  function indicatorTable(rows, ym, withType) {
    var codesList = [], byCode = {};
    rows.forEach(function (r) {
      if (!byCode[r.code]) { byCode[r.code] = { name: r.name, type: r.type, m: {} }; codesList.push(r.code); }
      byCode[r.code].m[r.ym] = r;
    });
    var m12 = []; for (var k = 11; k >= 0; k--) m12.push(ymShift(ym, -k));
    var order = { '結構': 1, '過程': 2, '結果': 3, '平衡': 4 };
    codesList.sort(function (a, b) { return (order[byCode[a].type] || 9) - (order[byCode[b].type] || 9) || (a < b ? -1 : 1); });
    var isSmall = function (c) { var cur = byCode[c].m[ym]; return !cur || cur.small; };
    var head = '<div class="tablewrap"><table class="t"><thead><tr><th>指標</th>' + (withType ? '<th>類型</th>' : '') + '<th>' + esc(ym) + '</th><th>近 12 月</th></tr></thead><tbody>';
    var rowHtml = function (c) {
        var x = byCode[c], cur = x.m[ym];
        var extra = cur && cur.mean !== null && cur.mean !== undefined ? '<div class="note">平均 ' + cur.mean + '／中位數 ' + cur.median + '／截尾平均 ' + cur.tmean + '</div>' : '';
        return '<tr><td><span title="' + esc(c) + '">' + esc(x.name) + '</span></td>' + (withType ? '<td>' + esc(x.type) + '</td>' : '') + '<td class="num">' + cell(cur) + extra + '</td><td>' +
          spark(m12.map(function (m) { var r = x.m[m]; return r && r.rate !== null && !r.small ? r.rate : null; })) + '</td></tr>';
    };
    if (!codesList.length) return '<div class="empty">所選期間無資料</div>';
    var big = codesList.filter(function (c) { return !isSmall(c); }), small = codesList.filter(isSmall);
    return (big.length ? head + big.map(rowHtml).join('') + '</tbody></table></div>' : '<div class="empty">本月所有指標樣本不足（分母低於 ' + S.boot.settings.minN + '）</div>') +
      (small.length ? '<details class="sub"><summary>樣本不足或本月無資料的指標（' + small.length + '）</summary>' + head + small.map(rowHtml).join('') + '</tbody></table></div></details>' : '');
  }
  function viewDashboard(view) {
    var nowYm = today().slice(0, 7);
    var dim = S.dashDim || 'PACK';
    view.innerHTML = '<div class="card"><h2>成效儀表板</h2><div class="seg" role="tablist">' +
      [['PACK', '照護面向'], ['DEVICE', '裝置類型'], ['DRUG', '藥品'], ['ATC', '藥品類別']].map(function (x) {
        return '<button type="button" role="tab" data-dim="' + x[0] + '" class="' + (dim === x[0] ? 'on' : '') + '">' + x[1] + '</button>';
      }).join('') + '</div><div class="row two"><div><label class="f" id="dpl">項目</label><select id="dp"></select></div>' +
      '<div><label class="f">月份</label><select id="dm"></select></div></div><div class="note" id="dlast"></div></div><div id="dres"><div class="empty">載入中…</div></div>';
    var months = [];
    for (var i = 0; i < 24; i++) months.push(ymShift(nowYm, -i));
    $('#dm').innerHTML = months.map(function (m) { return '<option>' + m + '</option>'; }).join('');
    $('#dm').value = S.dashYm || nowYm;
    $$('[data-dim]', view).forEach(function (b) { b.addEventListener('click', function () { S.dashDim = b.getAttribute('data-dim'); S.dashKey = ''; route(); }); });
    var load = function () {
      S.dashYm = $('#dm').value;
      var ym = S.dashYm, sel = $('#dp');
      if (dim === 'PACK') {
        S.dashPack = sel.value || S.dashPack || 'ALL';
        vapi('dashboard', { pack: S.dashPack, from: ymShift(ym, -11), to: ym }).then(function (d) {
          sel.innerHTML = d.packs.map(function (p) { return '<option value="' + esc(p.code) + '">' + esc(p.name) + '</option>'; }).join('');
          sel.value = d.pack;
          $('#dlast').textContent = '最後彙總：' + (d.lastRun || '尚未執行') + '。比率＝分子／分母；分母低於 ' + S.boot.settings.minN + ' 時不顯示比率。已排除測試病歷號；舊版遷移紀錄已歸檔，不納入。';
          var k = d.kpis || {};
          var kp = '<div class="card"><h2>近 12 個月重點（' + esc(ymShift(ym, -11)) + '～' + esc(ym) + '）</h2><div class="kpis">' +
            '<div><b>' + (k.records || 0) + '</b><span>指導人次</span></div>' +
            '<div><b>' + (k.fixed || 0) + '</b><span>不當用藥行為已修正（發現 ' + (k.behaviors || 0) + ' 筆）</span></div>' +
            '<div><b>' + (k.rate === null || k.rate === undefined ? '—' : k.rate + '%') + '</b><span>追蹤改善率（' + (k.fixed || 0) + '／' + (k.checked || 0) + '）</span></div></div></div>';
          var mine = d.person.filter(function (p) { return p.ym === ym; });
          var ptable = '<div class="card"><h2>個人／單位工作量（' + esc(ym) + '）</h2>' + (mine.length ? '<div class="tablewrap"><table class="t"><thead><tr><th>人員</th><th>面向</th><th>件數</th><th>追蹤到期</th><th>追蹤完成</th></tr></thead><tbody>' +
            mine.map(function (p) { return '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.packName || p.pack) + '</td><td class="num">' + p.n + '</td><td class="num">' + p.due + '</td><td class="num">' + p.done + '</td></tr>'; }).join('') +
            '</tbody></table></div>' : '<div class="empty">本月無個人資料</div>') + '</div>';
          $('#dres').innerHTML = kp + '<div class="card"><h2>' + esc(sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].text : '') + '</h2>' + indicatorTable(d.rows, ym, true) + '</div>' + ptable;
        }).catch(function (e) { $('#dres').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
      } else {
        S.dashKey = sel.value || S.dashKey || '';
        vapi('dashDrug', { dim: dim, key: S.dashKey, from: ymShift(ym, -11), to: ym }).then(function (d) {
          if (!d.keys.length) { $('#dres').innerHTML = '<div class="empty">尚無技巧評估資料</div>'; sel.innerHTML = ''; return; }
          sel.innerHTML = d.keys.map(function (k) { return '<option value="' + esc(k.key) + '">' + esc(k.name || k.key) + '（' + k.n + ' 次）</option>'; }).join('');
          if (!d.key) { S.dashKey = d.keys[0].key; return load(); }
          sel.value = d.key;
          $('#dlast').textContent = '最後彙總：' + (d.lastRun || '尚未執行') + '。D 指標以技巧評估為單位；分母低於 ' + S.boot.settings.minN + ' 時不顯示比率。';
          $('#dres').innerHTML = '<div class="card"><h2>' + esc(sel.options[sel.selectedIndex].text) + '</h2>' + indicatorTable(d.rows, ym, false) + '</div>';
        }).catch(function (e) { $('#dres').innerHTML = '<div class="msg err">' + esc(e.message) + '</div>'; });
      }
    };
    $('#dpl').textContent = { PACK: '照護面向', DEVICE: '裝置類型', DRUG: '藥品', ATC: '藥品類別（ATC 4 碼）' }[dim];
    $('#dp').addEventListener('change', load);
    $('#dm').addEventListener('change', load);
    load();
  }

  start();
})();
