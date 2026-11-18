'use strict';

/* ============================================================
   DoomReader
   Your Supabase URL and publishable key live in config.js (not here),
   so updating this file never overwrites them.
   ============================================================ */
var CONFIG = window.DOOMREADER_CONFIG || {};
var SUPABASE_URL = CONFIG.SUPABASE_URL || 'https://asqagrzeadzmtedttfzi.supabase.co';
var SUPABASE_KEY = CONFIG.SUPABASE_KEY || 'sb_publishable_5LpOZw3izDYGbB4IgwCsdg_gKy8rSYq';
var PRODUCT_ID = 'reading-app';

var MAX_BOOK_CHARS = 3000000;
var MAX_QUOTE_CHARS = 600;

var sb = null;
var currentUser = null;
var state = freshState();

function freshState() {
  return {
    books: [],
    highlights: [],
    comments: [],
    commentError: null,
    sessions: [],
    events: [],
    devices: [],
    deviceError: null,
    libTab: 'this',
    view: 'feed',
    returnView: 'library',
    feedDirty: true
  };
}

function $(id) { return document.getElementById(id); }

function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

function showMsg(id, text, type) {
  var n = $(id);
  if (!n) return;
  n.className = 'msg ' + (type || 'info');
  n.textContent = text;
}

function clearMsg(id) {
  var n = $(id);
  if (n) { n.textContent = ''; n.className = 'msg'; }
}

var toastTimer = null;
function toast(text) {
  var t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

/* ============================================================
   Auth + Etsy order unlock
   ============================================================ */
function showAuthForm(which) {
  ['login', 'signup', 'unlock'].forEach(function (n) {
    $('form-' + n).style.display = (n === which) ? 'block' : 'none';
  });
  $('auth-screen').style.display = 'flex';
  $('app').style.display = 'none';
}

async function handleLogin(e) {
  e.preventDefault();
  var email = $('login-email').value.trim();
  var pass = $('login-password').value;
  if (!email || !pass) return showMsg('login-msg', 'Please fill in both fields.', 'error');
  showMsg('login-msg', 'Logging in...', 'info');
  var res = await sb.auth.signInWithPassword({ email: email, password: pass });
  if (res.error) return showMsg('login-msg', 'Wrong email or password.', 'error');
  currentUser = res.data.user;
  clearMsg('login-msg');
  onLoggedIn();
}

async function handleSignup(e) {
  e.preventDefault();
  var email = $('signup-email').value.trim();
  var pass = $('signup-password').value;
  if (!email || !pass) return showMsg('signup-msg', 'Please fill in all fields.', 'error');
  showMsg('signup-msg', 'Creating your account...', 'info');
  var res = await sb.auth.signUp({ email: email, password: pass });
  if (res.error) return showMsg('signup-msg', res.error.message, 'error');
  if (res.data && res.data.session) {
    currentUser = res.data.user;
    clearMsg('signup-msg');
    return onLoggedIn();
  }
  showMsg('signup-msg', 'Account created! Check your email to confirm, then log in. You will enter your Etsy Order number after you log in.', 'success');
}

async function onLoggedIn() {
  var res = await sb.rpc('has_access', { p_product: PRODUCT_ID });
  if (res.error) {
    showAuthForm('login');
    showMsg('login-msg', "Couldn't check your account. Check your connection and try again.", 'error');
    return;
  }
  if (res.data === true) {
    enterApp();
  } else {
    showUnlock();
  }
}

function showUnlock() {
  $('unlock-who').textContent = 'Logged in as ' + (currentUser ? currentUser.email : '') + '. Enter your Etsy order details to unlock DoomReader.';
  clearMsg('unlock-msg');
  showAuthForm('unlock');
}

async function handleUnlock(e) {
  e.preventDefault();
  var order = $('unlock-order').value.replace(/\D/g, '');
  var email = $('unlock-email').value.trim();
  if (!order || !email) return showMsg('unlock-msg', 'Please fill in both fields.', 'error');
  showMsg('unlock-msg', 'Checking your order...', 'info');
  var res = await sb.rpc('claim_order', { p_order_number: order, p_email: email, p_product: PRODUCT_ID });
  if (res.error) return showMsg('unlock-msg', "Couldn't check your order. Check your connection and try again.", 'error');
  if (res.data !== true) return showMsg('unlock-msg', "Couldn't verify that order. Use the Order number and the email from your Etsy order. Just bought it? Wait up to 10 minutes and try again.", 'error');
  showMsg('unlock-msg', 'Unlocked!', 'success');
  enterApp();
}

async function handleLogout() {
  if (reader) await closeReader();
  flushEvents();
  await sb.auth.signOut();
  currentUser = null;
  state = freshState();
  $('login-password').value = '';
  showAuthForm('login');
}

async function checkSession() {
  var res = await sb.auth.getSession();
  if (res.data && res.data.session) {
    currentUser = res.data.session.user;
    onLoggedIn();
  } else {
    showAuthForm('login');
  }
}

/* ============================================================
   Local storage for book text (IndexedDB, stays on this device)
   ============================================================ */
var _db = null;
function openDb() {
  if (_db) return Promise.resolve(_db);
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('doomreader', 1);
    req.onupgradeneeded = function () { req.result.createObjectStore('texts'); };
    req.onsuccess = function () { _db = req.result; resolve(_db); };
    req.onerror = function () { reject(req.error); };
  });
}
function idbRun(mode, fn) {
  return openDb().then(function (db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction('texts', mode);
      var req = fn(tx.objectStore('texts'));
      tx.oncomplete = function () { resolve(req ? req.result : undefined); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error); };
    });
  });
}
function idbGet(key) { return idbRun('readonly', function (s) { return s.get(key); }); }
function idbSet(key, val) { return idbRun('readwrite', function (s) { return s.put(val, key); }); }
function idbDel(key) { return idbRun('readwrite', function (s) { return s.delete(key); }); }

/* ============================================================
   Data loading
   ============================================================ */
async function enterApp() {
  $('auth-screen').style.display = 'none';
  $('app').style.display = 'flex';
  state.feedDirty = true;
  showView('feed');
  $('feed-scroll').textContent = '';
  $('feed-scroll').appendChild(loadingCard());
  await loadAll();
  state.feedDirty = true;
  updateBadge();
  if (state.devices.length && !state.deviceError) await askWhichDevice();
  if (state.view === 'feed') renderFeed();
  if (state.view === 'library') renderLibrary();
}

function loadingCard() {
  var c = el('div', 'card c-end');
  c.appendChild(el('div', 'card-kicker', 'Loading'));
  c.appendChild(el('p', 'card-text', 'Getting your books...'));
  return c;
}

async function loadAll() {
  var since60 = new Date(Date.now() - 60 * 86400000).toISOString();
  var since14 = new Date(Date.now() - 14 * 86400000).toISOString();
  var r = await Promise.all([
    sb.from('books').select('*').order('created_at', { ascending: false }),
    sb.from('highlights').select('*').order('created_at', { ascending: false }),
    sb.from('reading_sessions').select('book_id,started_at,seconds').gte('started_at', since60),
    sb.from('feed_events').select('card_type,ref_id,event,created_at').gte('created_at', since14).limit(2000),
    sb.from('devices').select('*').order('slot', { ascending: true }),
    sb.from('highlight_comments').select('*').order('created_at', { ascending: true })
  ]);
  state.books = (r[0].data || []);
  state.highlights = (r[1].data || []);
  state.sessions = (r[2].data || []);
  state.events = (r[3].data || []);
  var firstErr = r[0].error || r[1].error;
  state.loadError = firstErr ? (firstErr.message || 'unknown error') : null;
  state.comments = (r[5] && r[5].data) || [];
  state.commentError = (r[5] && r[5].error) ? (r[5].error.message || 'unknown error') : null;
  state.devices = (r[4] && r[4].data) || [];
  state.deviceError = (r[4] && r[4].error) ? (r[4].error.message || 'unknown error') : null;
  await ensureSlots();
  syncDevice().then(function () { if (state.view === 'library') renderLibrary(); });
}

/* ============================================================
   Views
   ============================================================ */
function showView(name) {
  state.view = name;
  ['feed', 'library', 'reader', 'edit'].forEach(function (v) {
    $('view-' + v).classList.toggle('active', v === name);
  });
  $('nav').style.display = (name === 'reader' || name === 'edit') ? 'none' : 'flex';
  Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
    b.classList.toggle('active', b.getAttribute('data-view') === name);
  });
  if (name !== 'reader') { hideHlBtn(); hideBm(); }
  if (name === 'feed') { if (state.feedDirty) renderFeed(); }
  if (name === 'library') renderLibrary();
}

/* ============================================================
   Feed: events, ranking, cards
   ============================================================ */
var evQueue = [];
function logEvent(cardType, refId, ev) {
  if (!currentUser) return;
  evQueue.push({ user_id: currentUser.id, card_type: cardType, ref_id: refId || null, event: ev });
  state.events.push({ card_type: cardType, ref_id: refId || null, event: ev, created_at: new Date().toISOString() });
  if (evQueue.length >= 10) flushEvents();
}
async function flushEvents() {
  if (!evQueue.length || !sb) return;
  var rows = evQueue;
  evQueue = [];
  try { await sb.from('feed_events').insert(rows); } catch (e) { /* events are best effort */ }
}
setInterval(flushEvents, 8000);
window.addEventListener('pagehide', flushEvents);

function dayKey(d) {
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
}

function computeStreak() {
  var days = {};
  state.sessions.forEach(function (s) {
    if (s.seconds >= 60) days[dayKey(new Date(s.started_at))] = true;
  });
  var d = new Date();
  if (!days[dayKey(d)]) d.setDate(d.getDate() - 1);
  var n = 0;
  while (days[dayKey(d)]) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

function minutesToday() {
  var k = dayKey(new Date());
  var secs = 0;
  state.sessions.forEach(function (s) {
    if (dayKey(new Date(s.started_at)) === k) secs += s.seconds;
  });
  return Math.round(secs / 60);
}

function eventStats() {
  var now = Date.now();
  var s = { shown: {}, liked: {}, skipped: {}, bookLikes: {}, bookMins: {} };
  state.events.forEach(function (e) {
    if (!e.ref_id) return;
    var t = new Date(e.created_at).getTime();
    if (e.event === 'shown' && now - t < 3 * 86400000) s.shown[e.ref_id] = (s.shown[e.ref_id] || 0) + 1;
    else if (e.event === 'liked' || e.event === 'saved') s.liked[e.ref_id] = (s.liked[e.ref_id] || 0) + 1;
    else if (e.event === 'skipped') s.skipped[e.ref_id] = (s.skipped[e.ref_id] || 0) + 1;
  });
  state.highlights.forEach(function (h) {
    if (s.liked[h.id]) s.bookLikes[h.book_id] = (s.bookLikes[h.book_id] || 0) + s.liked[h.id];
  });
  state.sessions.forEach(function (x) {
    if (!x.book_id) return;
    if (now - new Date(x.started_at).getTime() < 7 * 86400000) s.bookMins[x.book_id] = (s.bookMins[x.book_id] || 0) + x.seconds / 60;
  });
  return s;
}

function scoreHighlight(h, stats) {
  var score = 1;
  score += 0.8 * Math.min(2, stats.liked[h.id] || 0);
  score += 0.4 * Math.min(3, stats.bookLikes[h.book_id] || 0);
  score += 0.5 * Math.min(1, (stats.bookMins[h.book_id] || 0) / 30);
  score -= 0.6 * (stats.shown[h.id] || 0);
  score -= 0.9 * (stats.skipped[h.id] || 0);
  if (Date.now() - new Date(h.created_at).getTime() < 2 * 86400000) score += 0.3;
  score += Math.random() * 0.8;
  return score;
}

function buildFeed() {
  var cards = [];
  if (state.books.length === 0) {
    cards.push({ type: 'empty' });
    return cards;
  }

  cards.push({ type: 'streak', streak: computeStreak(), minutes: minutesToday() });

  var open = state.books.filter(function (b) { return b.status !== 'finished'; });
  open.sort(function (a, b) {
    if (a.status !== b.status) return a.status === 'reading' ? -1 : 1;
    return new Date(b.last_read_at || b.created_at) - new Date(a.last_read_at || a.created_at);
  });
  var cont = open.slice(0, 3);

  var stats = eventStats();
  var byId = {};
  state.books.forEach(function (b) { byId[b.id] = b; });
  var hl = state.highlights
    .filter(function (h) { return byId[h.book_id]; })
    .map(function (h) { return { h: h, s: scoreHighlight(h, stats) }; })
    .sort(function (a, b) { return b.s - a.s; })
    .slice(0, 24);

  var ci = 0;
  hl.forEach(function (x, i) {
    if (i > 0 && i % 5 === 0 && cont.length) {
      cards.push({ type: 'continue', book: cont[ci % cont.length] });
      ci++;
    }
    cards.push({ type: 'highlight', h: x.h, book: byId[x.h.book_id] });
  });
  if (hl.length === 0 && cont.length) {
    cont.forEach(function (b) { cards.push({ type: 'continue', book: b }); });
  } else if (ci === 0 && cont.length) {
    cards.push({ type: 'continue', book: cont[0] });
  }
  cards.push({ type: 'end', hasHighlights: hl.length > 0, book: cont[0] || null });
  return cards;
}

var feedObserver = null;
function renderFeed() {
  state.feedDirty = false;
  var box = $('feed-scroll');
  if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
  box.textContent = '';
  var cards = buildFeed();
  var palette = 0;
  cards.forEach(function (c) {
    var node = renderCard(c, palette);
    if (c.type === 'highlight') palette++;
    box.appendChild(node);
  });
  box.scrollTop = 0;
  observeCards(box);
}

function observeCards(box) {
  if (!('IntersectionObserver' in window)) return;
  feedObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      var n = en.target;
      var type = n.getAttribute('data-type');
      var ref = n.getAttribute('data-ref') || null;
      if (en.intersectionRatio >= 0.6) {
        n._enter = Date.now();
        if (!n._shown) {
          n._shown = true;
          logEvent(type, ref, 'shown');
        }
      } else if (n._enter) {
        var dwell = Date.now() - n._enter;
        n._enter = null;
        if (dwell < 1200 && type === 'highlight') logEvent(type, ref, 'skipped');
      }
    });
  }, { root: box, threshold: [0, 0.6] });
  Array.prototype.forEach.call(box.querySelectorAll('.card'), function (n) { feedObserver.observe(n); });
}

var SVG_HEART = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-4.6-9.5-9C1 8.5 3 5 6.5 5c2 0 3.5 1 5.5 3 2-2 3.5-3 5.5-3C21 5 23 8.5 21.5 12 19 16.4 12 21 12 21z"/></svg>';
var SVG_MARK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
var SVG_COMMENT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>';
var SVG_BOOK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-7a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h8z"/></svg>';

function iconBtn(svg, label, handler) {
  var b = el('button', 'icon-btn');
  b.type = 'button';
  b.innerHTML = svg;
  b.appendChild(document.createTextNode(label));
  b.addEventListener('click', function () { handler(b); });
  return b;
}

function renderCard(c, palette) {
  var node = el('div', 'card');
  node.setAttribute('data-type', c.type);

  if (c.type === 'highlight') {
    node.classList.add('hc-' + hlColor(c.h));
    node.setAttribute('data-ref', c.h.id);
    node.appendChild(el('div', 'card-kicker', 'From your highlights'));
    var q = el('p', 'quote', '“' + c.h.quote + '”');
    if (c.h.quote.length > 220) q.classList.add('long');
    node.appendChild(q);
    var meta = el('div', 'card-meta', c.book.title);
    if (c.book.author) meta.appendChild(el('small', '', c.book.author));
    node.appendChild(meta);
    if (c.h.note) node.appendChild(el('div', 'card-note', c.h.note));
    var thread = commentsFor(c.h.id);
    if (thread.length) {
      var tb = el('div', 'card-thread');
      thread.slice(0, 2).forEach(function (cm) {
        var t = cm.body.length > 140 ? cm.body.slice(0, 140) + '\u2026' : cm.body;
        tb.appendChild(el('div', 'card-thread-item', t));
      });
      if (thread.length > 2) tb.appendChild(el('div', 'card-thread-more', '+ ' + (thread.length - 2) + ' more in this thread'));
      node.appendChild(tb);
    }

    var acts = el('div', 'card-actions');
    var liked = false, saved = false;
    acts.appendChild(iconBtn(SVG_HEART, 'Like', function (b) {
      liked = !liked;
      b.classList.toggle('on', liked);
      if (liked) logEvent('highlight', c.h.id, 'liked');
    }));
    acts.appendChild(iconBtn(SVG_MARK, 'Save', function (b) {
      saved = !saved;
      b.classList.toggle('on', saved);
      if (saved) { logEvent('highlight', c.h.id, 'saved'); toast('Saved'); }
    }));
    acts.appendChild(iconBtn(SVG_COMMENT, thread.length ? thread.length + (thread.length === 1 ? ' comment' : ' comments') : 'Comment', function () {
      logEvent('highlight', c.h.id, 'opened');
      openHlPanel(c.h.id, 'feed');
    }));
    acts.appendChild(iconBtn(SVG_BOOK, 'Read', function () {
      logEvent('highlight', c.h.id, 'opened');
      var p = (c.h.position_pct != null) ? Math.max(0, Number(c.h.position_pct) - 0.3) : null;
      state.returnView = 'feed';
      openBook(c.book.id, p);
    }));
    node.appendChild(acts);

  } else if (c.type === 'continue') {
    node.classList.add('c3');
    node.setAttribute('data-ref', c.book.id);
    node.appendChild(el('div', 'card-kicker', c.book.status === 'reading' ? 'Continue reading' : 'Up next'));
    node.appendChild(el('p', 'quote', c.book.title));
    if (c.book.author) node.appendChild(el('div', 'card-meta', c.book.author));
    var pct = Math.round(Number(c.book.progress_pct) || 0);
    var bar = el('div', 'progress');
    var fill = el('div');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    node.appendChild(bar);
    node.appendChild(el('div', 'card-meta', pct + '% read'));
    var a2 = el('div', 'card-actions');
    a2.appendChild(iconBtn(SVG_BOOK, c.book.status === 'reading' ? 'Continue' : 'Start reading', function () {
      logEvent('continue', c.book.id, 'opened');
      state.returnView = 'feed';
      openBook(c.book.id, null);
    }));
    node.appendChild(a2);

  } else if (c.type === 'streak') {
    node.classList.add('c-streak');
    node.appendChild(el('div', 'card-kicker', 'Your streak'));
    node.appendChild(el('div', 'big-number', String(c.streak)));
    node.appendChild(el('div', 'big-label', c.streak === 1 ? 'day in a row' : 'days in a row'));
    node.appendChild(el('p', 'card-text', c.minutes > 0
      ? c.minutes + ' min read today. Keep it going.'
      : 'Nothing read yet today. One page keeps the streak alive.'));

  } else if (c.type === 'end') {
    node.classList.add('c-end');
    node.appendChild(el('div', 'card-kicker', 'End of feed'));
    node.appendChild(el('p', 'quote', 'That is everything. Now go read.'));
    if (!c.hasHighlights) {
      node.appendChild(el('p', 'card-text', 'Select a line while you read and tap Highlight. Your highlights show up here as cards.'));
    }
    var a3 = el('div', 'card-actions');
    if (c.book) {
      a3.appendChild(iconBtn(SVG_BOOK, 'Open ' + (c.book.status === 'reading' ? 'your book' : 'next book'), function () {
        logEvent('end', null, 'opened');
        state.returnView = 'feed';
        openBook(c.book.id, null);
      }));
    }
    node.appendChild(a3);

  } else {
    node.classList.add('c-end');
    node.appendChild(el('div', 'card-kicker', 'Welcome'));
    node.appendChild(el('p', 'quote', 'Add your first book to start your feed.'));
    node.appendChild(el('p', 'card-text', 'Paste the text or choose a .txt file. Highlight lines as you read and they come back here as cards.'));
    var a4 = el('div', 'card-actions');
    a4.appendChild(iconBtn(SVG_BOOK, 'Add a book', function () {
      showView('library');
      openAddModal();
    }));
    node.appendChild(a4);
  }
  return node;
}

/* ============================================================
   Library
   ============================================================ */
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return Math.round(n / 1024) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

async function estimateBrowser() {
  if (navigator.storage && navigator.storage.estimate) {
    var e = await navigator.storage.estimate();
    return { usage: e.usage || 0, quota: e.quota || 0 };
  }
  return null;
}

function countWords(s) {
  var n = 0, inWord = false;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    var space = c === 32 || c === 10 || c === 9 || c === 13 || c === 160;
    if (!space && !inWord) { n++; inWord = true; } else if (space) { inWord = false; }
  }
  return n;
}
function chaptersWords(chapters) {
  var n = 0;
  chapters.forEach(function (ch) { n += countWords(ch.title || '') + countWords(ch.body || ''); });
  return n;
}

async function deviceTextSizes() {
  var db = await openDb();
  return new Promise(function (resolve) {
    var sizes = {}, words = {}, total = 0;
    var tx = db.transaction('texts', 'readonly');
    var req = tx.objectStore('texts').openCursor();
    req.onsuccess = function () {
      var c = req.result;
      if (!c) return resolve({ sizes: sizes, total: total, words: words });
      var v = c.value, n = 0, w = 0;
      if (typeof v === 'string') { n = v.length; w = countWords(v); }
      else if (v && v.chapters) v.chapters.forEach(function (ch) {
        n += (ch.title || '').length + (ch.body || '').length;
        w += countWords(ch.title || '') + countWords(ch.body || '');
      });
      sizes[c.key] = n;
      words[c.key] = w;
      total += n;
      c.continue();
    };
    req.onerror = function () { resolve({ sizes: {}, total: 0, words: {} }); };
  });
}

async function refreshData() {
  toast('Refreshing...');
  await loadAll();
  state.feedDirty = true;
  renderLibrary();
  toast(state.loadError ? "Couldn't load. See the message above." : 'Up to date');
}

function renderLibStatus(dev, est, myName) {
  var box = $('lib-status');
  box.textContent = '';
  if (state.loadError) {
    box.appendChild(el('div', 'msg error', "Couldn't load your books from your account: " + state.loadError));
  }
  if (state.deviceError) {
    box.appendChild(el('div', 'msg error', "Device lists aren't working yet: " + state.deviceError + '. Run the new device SQL step in Supabase, then tap Refresh.'));
  }
  if (state.commentError) {
    box.appendChild(el('div', 'msg error', "Comments aren't working yet: " + state.commentError + '. Run the new highlight SQL step in Supabase, then tap Refresh.'));
  }
  var onDevice = Object.keys(dev.sizes).length;
  var n = state.books.length;
  box.appendChild(el('div', 'book-meta', 'Signed in as ' + (currentUser ? currentUser.email : '') + '  \u00B7  ' +
    n + (n === 1 ? ' book' : ' books') + ' in your account  \u00B7  text on this device for ' + onDevice));
  if (est && est.quota) {
    var pct = est.usage / est.quota * 100;
    var bar = el('div', 'meter');
    var fill = el('div');
    fill.style.width = Math.min(100, Math.max(1, pct)) + '%';
    bar.appendChild(fill);
    box.appendChild(bar);
    box.appendChild(el('div', 'book-meta', 'Storage on ' + (myName ? myName : 'this device') + ': ' + fmtBytes(est.usage) + ' of about ' + fmtBytes(est.quota) +
      ' (' + (pct < 0.1 ? 'under 0.1' : pct.toFixed(1)) + '%)  \u00B7  book text: ' + fmtBytes(dev.total)));
  } else {
    box.appendChild(el('div', 'book-meta', 'Book text on this device: ' + fmtBytes(dev.total)));
  }
  var rf = el('button', 'btn-mini', 'Refresh');
  rf.type = 'button';
  rf.addEventListener('click', refreshData);
  box.appendChild(rf);
}

/* ---------- devices: four slots you can rename, and you say which one you are ---------- */
var DEFAULT_SLOTS = ['Laptop', 'Work computer', 'Phone', 'Tablet'];
var deviceIdCache = {};
var slotIdCache = {};
var syncTimer = null;

function makeId() {
  if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    var r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  });
}

// A hidden ID for this one browser (used so browsers sharing a device slot don't overwrite each other)
function getDeviceId() {
  var key = 'dr_device_' + (currentUser ? currentUser.id : 'anon');
  if (deviceIdCache[key]) return deviceIdCache[key];
  var id = null;
  try { id = localStorage.getItem(key); } catch (e) { id = null; }
  if (!id) {
    id = makeId();
    try { localStorage.setItem(key, id); } catch (e) { /* ignore */ }
  }
  deviceIdCache[key] = id;
  return id;
}

// Which of your four device slots you said this browser is
function slotKey() { return 'dr_slot_' + (currentUser ? currentUser.id : 'anon'); }
function getMySlotId() {
  var k = slotKey();
  if (slotIdCache[k]) return slotIdCache[k];
  var id = null;
  try { id = localStorage.getItem(k); } catch (e) { id = null; }
  if (id) slotIdCache[k] = id;
  return id;
}
function storeMySlotId(id) {
  var k = slotKey();
  slotIdCache[k] = id;
  try { localStorage.setItem(k, id); } catch (e) { /* ignore */ }
}

function rowById(id) {
  return state.devices.filter(function (d) { return d.id === id; })[0] || null;
}
function myRow() {
  var id = getMySlotId();
  return id ? rowById(id) : null;
}
function getDeviceName() {
  var r = myRow();
  return r ? r.name : null;
}

function cleanName(s) { return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 30); }

function summarizeHoldings(h) {
  var all = {}, total = 0;
  Object.keys(h).forEach(function (k) {
    ((h[k] && h[k].ids) || []).forEach(function (i) { all[i] = 1; });
    total += (h[k] && h[k].bytes) || 0;
  });
  return { ids: Object.keys(all), bytes: total };
}

function replaceRow(row) {
  var found = false;
  state.devices = state.devices.map(function (d) {
    if (d.id === row.id) { found = true; return row; }
    return d;
  });
  if (!found) state.devices.push(row);
}

// Your account keeps four device slots. They are created the first time.
async function ensureSlots() {
  if (!sb || !currentUser || state.deviceError || state.devices.length > 0) return;
  var rows = DEFAULT_SLOTS.map(function (n, i) {
    return { id: makeId(), user_id: currentUser.id, slot: i, name: n, book_ids: [], bytes: 0, holdings: {} };
  });
  var res = await sb.from('devices').upsert(rows, { onConflict: 'user_id,slot', ignoreDuplicates: true });
  if (res.error) { state.deviceError = res.error.message || 'unknown error'; return; }
  var r = await sb.from('devices').select('*');
  if (r.error) { state.deviceError = r.error.message || 'unknown error'; return; }
  state.devices = r.data || [];
}

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(function () { syncDevice(); }, 1500);
}

// Tells your account which books have their text saved on this device
async function syncDevice() {
  var me = myRow();
  if (!sb || !currentUser || !me) return;
  try {
    var dev = await deviceTextSizes();
    var ids = state.books.map(function (b) { return b.id; }).filter(function (id) { return dev.sizes[id] !== undefined; });
    var bytes = 0;
    var wordMap = {};
    ids.forEach(function (id) { bytes += dev.sizes[id]; wordMap[id] = dev.words[id] || 0; });
    var holdings = {};
    var old = me.holdings || {};
    var cutoff = Date.now() - 90 * 86400000;
    Object.keys(old).forEach(function (k) {
      if (old[k] && old[k].at && new Date(old[k].at).getTime() > cutoff) holdings[k] = old[k];
    });
    var now = new Date().toISOString();
    holdings[getDeviceId()] = { ids: ids, bytes: bytes, words: wordMap, at: now };
    var sum = summarizeHoldings(holdings);
    var res = await sb.from('devices').update({ holdings: holdings, book_ids: sum.ids, bytes: sum.bytes, last_seen: now }).eq('id', me.id).select().single();
    if (res.error || !res.data) {
      state.deviceError = res.error ? (res.error.message || 'unknown error') : 'no response';
      return;
    }
    state.deviceError = null;
    replaceRow(res.data);
  } catch (e) {
    state.deviceError = String((e && e.message) || e);
  }
}

function updateBadge() {
  var n = getDeviceName();
  $('device-badge').textContent = '⚙ ' + (n ? n : 'Settings');
}

// Slots in order, with a flag for the one you said you are
function deviceList() {
  var myId = getMySlotId();
  return state.devices.slice().sort(function (a, b) { return (a.slot || 0) - (b.slot || 0); })
    .map(function (d) { return { id: d.id, name: d.name, row: d, isMe: d.id === myId }; });
}

// Does this device have this book's text?
function deviceHas(d, bookId, dev) {
  if (d.isMe && dev.sizes[bookId] !== undefined) return true;
  return !!(d.row && (d.row.book_ids || []).indexOf(bookId) !== -1);
}

// Word counts of this book on other copies: [{name, words}]
function otherCopies(bookId) {
  var myBid = getDeviceId();
  var out = [];
  state.devices.forEach(function (d) {
    var h = d.holdings || {};
    Object.keys(h).forEach(function (bid) {
      if (bid === myBid) return;
      var w = h[bid] && h[bid].words && h[bid].words[bookId];
      if (w) out.push({ name: d.name, words: w });
    });
  });
  return out;
}

// "Which device are you using?" Asked each time the app opens. Resolves when you pick one.
function askWhichDevice() {
  return new Promise(function (resolve) {
    var last = getMySlotId();
    var box = $('device-options');
    box.textContent = '';
    deviceList().forEach(function (d) {
      var b = el('button', 'btn dev-opt' + (d.id === last ? ' btn-primary' : ''), d.name);
      b.type = 'button';
      if (d.id === last) b.appendChild(el('span', 'dev-note', ' (last time)'));
      b.addEventListener('click', async function () {
        $('modal-device').style.display = 'none';
        await setMySlot(d.id);
        resolve(true);
      });
      box.appendChild(b);
    });
    $('modal-device').style.display = 'flex';
  });
}

async function setMySlot(id) {
  var bid = getDeviceId();
  var old = myRow();
  storeMySlotId(id);
  updateBadge();
  // take this browser out of the old device's list
  if (old && old.id !== id && old.holdings && old.holdings[bid]) {
    var h = Object.assign({}, old.holdings);
    delete h[bid];
    var sum = summarizeHoldings(h);
    try {
      var r = await sb.from('devices').update({ holdings: h, book_ids: sum.ids, bytes: sum.bytes }).eq('id', old.id).select().single();
      if (r.data) replaceRow(r.data);
    } catch (e) { /* best effort */ }
  }
  await syncDevice();
  state.libTab = 'this';
  updateBadge();
  if (state.view === 'library') renderLibrary();
}

/* ---------- settings ---------- */
function openSettings() {
  var box = $('settings-devices');
  box.textContent = '';
  clearMsg('settings-msg');
  var myId = getMySlotId();
  deviceList().forEach(function (d) {
    var row = el('div', 'set-row');
    var radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'mydev';
    radio.value = d.id;
    radio.checked = d.id === myId;
    radio.setAttribute('aria-label', 'I am using ' + d.name);
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 30;
    inp.value = d.name;
    inp.setAttribute('data-id', d.id);
    inp.setAttribute('aria-label', 'Name of device');
    row.appendChild(radio);
    row.appendChild(inp);
    box.appendChild(row);
  });
  $('modal-settings').style.display = 'flex';
}

async function saveSettings() {
  var inputs = Array.prototype.slice.call($('settings-devices').querySelectorAll('input[type=text]'));
  var names = inputs.map(function (i) { return cleanName(i.value); });
  if (names.some(function (n) { return !n; })) return showMsg('settings-msg', 'Every device needs a name.', 'error');
  var seen = {};
  for (var i = 0; i < names.length; i++) {
    var low = names[i].toLowerCase();
    if (seen[low]) return showMsg('settings-msg', 'Two devices are both called "' + names[i] + '". Give each a different name.', 'error');
    seen[low] = true;
  }
  showMsg('settings-msg', 'Saving...', 'info');
  for (var j = 0; j < inputs.length; j++) {
    var row = rowById(inputs[j].getAttribute('data-id'));
    if (row && row.name !== names[j]) {
      var r = await sb.from('devices').update({ name: names[j] }).eq('id', row.id).select().single();
      if (r.error) return showMsg('settings-msg', "Couldn't rename: " + r.error.message, 'error');
      if (r.data) replaceRow(r.data);
    }
  }
  var sel = $('settings-devices').querySelector('input[type=radio]:checked');
  if (sel && sel.value !== getMySlotId()) await setMySlot(sel.value);
  $('modal-settings').style.display = 'none';
  updateBadge();
  if (state.view === 'library') renderLibrary();
  toast('Saved');
}

function fmtWhen(iso) {
  if (!iso) return 'never';
  var d = new Date(iso);
  var time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  var now = new Date();
  var days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days <= 0) return 'today ' + time;
  if (days === 1) return 'yesterday ' + time;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function renderMatrix(dev, devices) {
  var box = $('lib-matrix');
  box.textContent = '';
  if (state.books.length === 0) {
    box.appendChild(el('p', 'book-meta', 'Add a book to see where it is saved.'));
    return;
  }
  if (devices.length === 0) {
    box.appendChild(el('p', 'book-meta', 'Device list is not available yet. See the message above.'));
    return;
  }
  var wrap = el('div', 'matrix-scroll');
  var grid = el('div', 'matrix');
  grid.style.gridTemplateColumns = 'minmax(110px, 1fr) repeat(' + devices.length + ', 64px)';
  grid.appendChild(el('div', 'mx-h mx-title', 'Book'));
  devices.forEach(function (d) {
    var c = el('div', 'mx-h' + (d.isMe ? ' me' : ''), d.name);
    c.title = 'Open ' + d.name;
    c.addEventListener('click', function () { state.libTab = d.id; renderLibrary(); });
    grid.appendChild(c);
  });
  state.books.forEach(function (b) {
    grid.appendChild(el('div', 'mx-title', b.title));
    devices.forEach(function (d) {
      var has = deviceHas(d, b.id, dev);
      grid.appendChild(el('div', 'mx-c' + (d.isMe ? ' me' : '') + (has ? ' yes' : ''), has ? '✓' : '–'));
    });
  });
  wrap.appendChild(grid);
  box.appendChild(wrap);
  box.appendChild(el('p', 'book-meta', '✓ = the book’s text is saved on that device. You can see every title everywhere, but a book only opens on a device that has its text. Tap a device name to see just its books.'));
}

async function renderLibrary() {
  var dev = { sizes: {}, total: 0 };
  var est = null;
  try { dev = await deviceTextSizes(); } catch (e) { /* ignore */ }
  try { est = await estimateBrowser(); } catch (e) { /* ignore */ }
  if (state.view !== 'library') return;
  var myName = getDeviceName();
  var devices = deviceList();
  updateBadge();
  renderLibStatus(dev, est, myName);
  renderMatrix(dev, devices);

  var tabKey = state.libTab;
  var meDev = devices.filter(function (d) { return d.isMe; })[0] || null;
  if (tabKey === 'this') tabKey = meDev ? meDev.id : 'all';
  if (tabKey !== 'all' && !devices.some(function (d) { return d.id === tabKey; })) tabKey = meDev ? meDev.id : 'all';
  var curDev = devices.filter(function (d) { return d.id === tabKey; })[0] || null;

  var tabBox = $('lib-tabs');
  tabBox.textContent = '';
  devices.forEach(function (d) {
    var b = el('button', 'tab' + (d.id === tabKey ? ' active' : ''), d.name + (d.isMe ? ' (you are here)' : ''));
    b.type = 'button';
    b.addEventListener('click', function () { state.libTab = d.id; renderLibrary(); });
    tabBox.appendChild(b);
  });
  var allTab = el('button', 'tab' + (tabKey === 'all' ? ' active' : ''), 'All books');
  allTab.type = 'button';
  allTab.addEventListener('click', function () { state.libTab = 'all'; renderLibrary(); });
  tabBox.appendChild(allTab);

  var books = state.books.filter(function (b) {
    return tabKey === 'all' ? true : deviceHas(curDev, b.id, dev);
  });

  var info = $('lib-tabinfo');
  info.textContent = '';
  if (!curDev) {
    info.appendChild(el('div', 'book-meta', 'Every book in your account, whether or not its text is saved on this device.'));
  } else {
    var bytes = curDev.isMe ? dev.total : (Number(curDev.row && curDev.row.bytes) || 0);
    var line = curDev.name + (curDev.isMe ? ' (you are here)' : '') + '  ·  ' + books.length + (books.length === 1 ? ' book' : ' books') +
      '  ·  ' + fmtBytes(bytes) + ' of book text';
    if (!curDev.isMe && curDev.row) line += '  ·  list updated ' + fmtWhen(curDev.row.last_seen);
    info.appendChild(el('div', 'book-meta', line));
  }
  var st = el('button', 'btn-mini', 'Settings (rename devices)');
  st.type = 'button';
  st.addEventListener('click', openSettings);
  info.appendChild(st);

  var list = $('library-list');
  list.textContent = '';
  if (books.length === 0) {
    var msg;
    if (state.books.length === 0) {
      msg = state.loadError
        ? 'Your books could not be loaded. See the message above.'
        : 'No books yet. Tap Add book to paste text or choose a .txt file.';
    } else if (curDev && curDev.isMe) {
      msg = 'No book text on this device yet. Open the All books tab to see your titles. A book only opens on a device that has its text.';
    } else {
      msg = (curDev ? curDev.name : 'This device') + ' has not saved any book text yet.';
    }
    list.appendChild(el('p', 'empty', msg));
    return;
  }
  var order = { reading: 0, queued: 1, finished: 2 };
  books = books.slice().sort(function (a, b) {
    if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
    return new Date(b.last_read_at || b.created_at) - new Date(a.last_read_at || a.created_at);
  });
  books.forEach(function (b) {
    var card = el('div', 'book');
    card.appendChild(el('div', 'book-title', b.title));
    if (b.author) card.appendChild(el('div', 'book-author', b.author));
    card.appendChild(el('span', 'chip ' + b.status, b.status === 'queued' ? 'Up next' : b.status));
    var pct = Math.round(Number(b.progress_pct) || 0);
    var bar = el('div', 'progress');
    var fill = el('div');
    fill.style.width = pct + '%';
    bar.appendChild(fill);
    card.appendChild(bar);
    var hlCount = state.highlights.filter(function (h) { return h.book_id === b.id; }).length;
    card.appendChild(el('div', 'book-meta', pct + '% read  ·  ' + hlCount + (hlCount === 1 ? ' highlight' : ' highlights')));

    var hold = devices.filter(function (d) { return deviceHas(d, b.id, dev); });
    var where = el('div', 'where');
    if (hold.length) {
      where.appendChild(el('span', 'where-label', 'Text saved on:'));
      hold.forEach(function (d) {
        where.appendChild(el('span', 'dev-chip' + (d.isMe ? ' me' : ''), d.name));
      });
      if (dev.sizes[b.id] !== undefined) where.appendChild(el('span', 'where-size', fmtBytes(dev.sizes[b.id]) + ' here'));
    } else {
      where.className = 'where warn';
      where.appendChild(el('span', '', 'Text saved on: nowhere yet.'));
    }
    card.appendChild(where);

    var acts = el('div', 'book-actions');
    var here = dev.sizes[b.id] !== undefined;
    var main = el('button', 'btn btn-primary btn-small',
      !here ? 'Add text here' : (b.status === 'queued' ? 'Start' : (b.status === 'finished' ? 'Read again' : 'Continue')));
    main.type = 'button';
    main.addEventListener('click', function () {
      if (!here) return openAddText(b, 'library');
      state.returnView = 'library';
      openBook(b.id, b.status === 'finished' ? 0 : null);
    });
    var edit = el('button', 'btn btn-small', 'Edit');
    edit.type = 'button';
    edit.addEventListener('click', function () { openEdit(b); });
    acts.appendChild(main);
    acts.appendChild(edit);
    if (here) {
      var rmt = el('button', 'btn btn-small', 'Remove text from this device');
      rmt.type = 'button';
      rmt.addEventListener('click', function () { removeLocalText(b); });
      acts.appendChild(rmt);
    }
    var del = el('button', 'btn btn-small', 'Delete book');
    del.type = 'button';
    del.addEventListener('click', function () { deleteBook(b); });
    acts.appendChild(del);
    card.appendChild(acts);
    list.appendChild(card);
  });
}

async function removeLocalText(b) {
  if (!window.confirm('Remove the text of "' + b.title + '" from this device? The title, your progress, your highlights, and copies on other devices stay.')) return;
  try { await idbDel(b.id); } catch (e) { return toast("Couldn't remove it from this device."); }
  state.feedDirty = true;
  scheduleSync();
  renderLibrary();
  toast('Text removed from this device');
}

/* ---------- add text to a book that is already in your account ---------- */
var addCtx = null;

function updateAtCount() {
  var n = countWords($('at-text').value);
  $('at-count').textContent = 'Words: ' + n.toLocaleString();
}

function openAddText(book, after) {
  addCtx = { book: book, after: after };
  $('at-title').textContent = book.title;
  $('at-devname').textContent = getDeviceName() || 'this device';
  $('at-text').value = '';
  $('at-file').value = '';
  $('at-warn').style.display = 'none';
  $('at-actions').style.display = '';
  clearMsg('at-msg');
  updateAtCount();
  $('modal-addtext').style.display = 'flex';
  $('at-text').dispatchEvent(new Event('input'));
}

function closeAddText() { $('modal-addtext').style.display = 'none'; addCtx = null; }

async function onAtFile() {
  var f = $('at-file').files && $('at-file').files[0];
  if (!f) return;
  if (!/\.txt$/i.test(f.name)) {
    $('at-file').value = '';
    return showMsg('at-msg', 'Choose a .txt file, or paste the text instead.', 'error');
  }
  try {
    $('at-text').value = (await readFileAsText(f)).replace(/\r\n/g, '\n');
    $('at-text').dispatchEvent(new Event('input'));
    clearMsg('at-msg');
  } catch (e) {
    showMsg('at-msg', "Couldn't read that file. Try pasting the text instead.", 'error');
  }
}

async function saveAddText(force) {
  if (!addCtx) return;
  var text = $('at-text').value.replace(/\r\n/g, '\n').trim();
  if (text.length < 20) return showMsg('at-msg', 'Paste some text or choose a .txt file first.', 'error');
  if (text.length > MAX_BOOK_CHARS) return showMsg('at-msg', 'That is too long for one book (limit about 3 million characters).', 'error');
  var chapters = parseMarkup(text);
  var n = chaptersWords(chapters);
  if (!force) {
    var others = otherCopies(addCtx.book.id);
    if (others.length) {
      var ref = Math.round(others.reduce(function (t, o) { return t + o.words; }, 0) / others.length);
      if (ref > 0 && Math.abs(n - ref) / ref > 0.15) {
        var names = [];
        others.forEach(function (o) { if (names.indexOf(o.name) === -1) names.push(o.name); });
        $('at-warn-text').textContent = 'This text has ' + n.toLocaleString() + ' words, but the copy on ' + names.join(' and ') +
          ' has about ' + ref.toLocaleString() + '. They may be different versions, or this may be the wrong book. Your reading position could land in a different spot.';
        $('at-warn').style.display = 'block';
        $('at-actions').style.display = 'none';
        return;
      }
    }
  }
  try {
    await saveChapters(addCtx.book.id, chapters);
  } catch (e) {
    return showMsg('at-msg', "Your browser wouldn't store the text. Free up space or try another browser.", 'error');
  }
  var ctx = addCtx;
  closeAddText();
  state.feedDirty = true;
  toast('Text saved to ' + (getDeviceName() || 'this device'));
  if (ctx.after === 'reader') openBook(ctx.book.id, null);
  else if (ctx.after === 'edit') openEdit(ctx.book);
  else renderLibrary();
}

async function deleteBook(b) {
  if (!window.confirm('Delete "' + b.title + '" from your whole account, with its highlights and progress? Its text on every device becomes unused. This cannot be undone. (To only clear the text from this device, use Remove text from this device.)')) return;
  var res = await sb.from('books').delete().eq('id', b.id);
  if (res.error) return toast("Couldn't delete. Try again.");
  try { await idbDel(b.id); } catch (e) { /* ignore */ }
  scheduleSync();
  state.books = state.books.filter(function (x) { return x.id !== b.id; });
  state.highlights = state.highlights.filter(function (x) { return x.book_id !== b.id; });
  state.feedDirty = true;
  renderLibrary();
  toast('Deleted');
}

/* ---------- add book ---------- */
function openAddModal() {
  $('add-title').value = '';
  $('add-author').value = '';
  $('add-file').value = '';
  $('add-text').value = '';
  clearMsg('add-msg');
  $('modal-add').style.display = 'flex';
  $('add-title').focus();
}
function closeAddModal() { $('modal-add').style.display = 'none'; }

function readFileAsText(file) {
  return new Promise(function (resolve, reject) {
    var fr = new FileReader();
    fr.onload = function () { resolve(String(fr.result || '')); };
    fr.onerror = function () { reject(fr.error); };
    fr.readAsText(file);
  });
}

async function getTextFrom(fileId, textId, msgId) {
  var f = $(fileId).files && $(fileId).files[0];
  var text = '';
  if (f) {
    if (!/\.txt$/i.test(f.name)) {
      showMsg(msgId, 'DoomReader reads .txt files for now. Save your book as a .txt file, or paste the text instead.', 'error');
      return null;
    }
    try { text = await readFileAsText(f); } catch (e) {
      showMsg(msgId, "Couldn't read that file. Try pasting the text instead.", 'error');
      return null;
    }
  } else {
    text = $(textId).value;
  }
  text = text.replace(/\r\n/g, '\n').trim();
  if (text.length < 20) {
    showMsg(msgId, 'Choose a .txt file or paste some text first.', 'error');
    return null;
  }
  if (text.length > MAX_BOOK_CHARS) {
    showMsg(msgId, 'That is too long for one book (limit about 3 million characters).', 'error');
    return null;
  }
  return text;
}

async function saveNewBook() {
  var title = $('add-title').value.trim();
  var author = $('add-author').value.trim();
  if (!title) return showMsg('add-msg', 'Add a title.', 'error');
  var text = await getTextFrom('add-file', 'add-text', 'add-msg');
  if (text === null) return;
  showMsg('add-msg', 'Saving...', 'info');
  var res = await sb.from('books').insert({
    user_id: currentUser.id,
    title: title,
    author: author || null
  }).select().single();
  if (res.error || !res.data) return showMsg('add-msg', "Couldn't save the book to your account: " + (res.error ? res.error.message : 'no response') + '. Nothing was added.', 'error');
  try {
    await saveChapters(res.data.id, parseMarkup(text));
  } catch (e) {
    await sb.from('books').delete().eq('id', res.data.id);
    return showMsg('add-msg', "Your browser wouldn't store the text. Free up space or try another browser.", 'error');
  }
  var chk = await sb.from('books').select('id').eq('id', res.data.id);
  if (chk.error || !chk.data || chk.data.length !== 1) {
    try { await idbDel(res.data.id); } catch (e) { /* ignore */ }
    await sb.from('books').delete().eq('id', res.data.id);
    return showMsg('add-msg', "Your account didn't confirm the save, so nothing was added" + (chk.error ? ': ' + chk.error.message : '.'), 'error');
  }
  state.books.unshift(res.data);
  state.feedDirty = true;
  closeAddModal();
  renderLibrary();
  toast('Saved to your account and this device');
}

/* ============================================================
   Reader
   ============================================================ */
var reader = null;
var fontSize = 19;
try { fontSize = parseInt(localStorage.getItem('dr_font'), 10) || 19; } catch (e) { /* ignore */ }

function applyFontSize() {
  $('reader-body').style.fontSize = fontSize + 'px';
  try { localStorage.setItem('dr_font', String(fontSize)); } catch (e) { /* ignore */ }
}

function scrollMax() {
  var sc = $('reader-scroll');
  return Math.max(0, sc.scrollHeight - sc.clientHeight);
}
function getPct() {
  var max = scrollMax();
  if (max <= 0) return 0;
  var p = $('reader-scroll').scrollTop / max * 100;
  return Math.round(Math.min(100, Math.max(0, p)) * 10) / 10;
}
function setScrollPct(p) {
  $('reader-scroll').scrollTop = scrollMax() * (p / 100);
}

/* ---------- chapter markup ----------
   A line starting with "# " begins a new chapter (the rest of the line is its title).
   A line starting with "## " is a subheading inside a chapter. */
function parseMarkup(text) {
  var lines = String(text).replace(/\r\n/g, '\n').split('\n');
  var chapters = [];
  var cur = { title: '', lines: [] };
  function push() {
    var body = cur.lines.join('\n').trim();
    if (cur.title || body) chapters.push({ title: cur.title, body: body });
  }
  lines.forEach(function (line) {
    var m = line.trim().match(/^#(?!#)\s*(\S.*)$/);
    if (m) {
      push();
      cur = { title: m[1].trim(), lines: [] };
    } else {
      cur.lines.push(line);
    }
  });
  push();
  if (chapters.length === 0) chapters.push({ title: '', body: String(text).trim() });
  return chapters;
}

function serializeChapters(chapters) {
  return chapters.map(function (c) {
    return (c.title ? '# ' + c.title + '\n\n' : '') + c.body.trim();
  }).join('\n\n');
}

function parseBody(body) {
  var lines = String(body).replace(/\r\n/g, '\n').split('\n');
  var blocks = [], cur = [];
  function flush() {
    if (cur.length) { blocks.push({ type: 'p', text: cur.join(' ') }); cur = []; }
  }
  lines.forEach(function (line) {
    var t = line.trim();
    var m = t.match(/^##(?!#)\s*(\S.*)$/);
    if (m) { flush(); blocks.push({ type: 'h', text: m[1].trim() }); }
    else if (t === '') flush();
    else cur.push(t);
  });
  flush();
  var pCount = blocks.filter(function (b) { return b.type === 'p'; }).length;
  if (pCount < 3 && String(body).length > 2000) {
    blocks = [];
    lines.forEach(function (line) {
      var t = line.trim();
      var m = t.match(/^##(?!#)\s*(\S.*)$/);
      if (m) blocks.push({ type: 'h', text: m[1].trim() });
      else if (t) blocks.push({ type: 'p', text: t });
    });
  }
  return blocks;
}

function detectChapterHeadings(text) {
  var count = 0;
  var re = /^(chapter|part|book|prologue|epilogue|introduction|preface|prelude|interlude|afterword)\b.{0,70}$/i;
  var lines = String(text).replace(/\r\n/g, '\n').split('\n');
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    var t = lines[i].trim();
    if (t && t.charAt(0) !== '#' && t.length <= 80 && re.test(t)) {
      count++;
      var nxt = (i + 1 < lines.length) ? lines[i + 1].trim() : '';
      var after = (i + 2 < lines.length) ? lines[i + 2].trim() : '';
      if (nxt && nxt.length <= 70 && nxt.charAt(0) !== '#' && !/[.,;:!?”"]$/.test(nxt) && !re.test(nxt) && after === '') {
        var sep = /[:\-–—]$/.test(t) ? ' ' : ': ';
        out.push('# ' + t + sep + nxt);
        i++;
      } else {
        out.push('# ' + t);
      }
    } else {
      out.push(lines[i]);
    }
  }
  return { text: out.join('\n'), count: count };
}

function detectSubheadings(text) {
  var lines = String(text).replace(/\r\n/g, '\n').split('\n');
  var count = 0;
  var out = lines.map(function (line, i) {
    var t = line.trim();
    if (!t || t.charAt(0) === '#') return line;
    if (t.length < 3 || t.length > 70) return line;
    if (t.split(/\s+/).length > 10) return line;
    if (/[.,;:”"…]$/.test(t)) return line;
    if (!/^[A-Z0-9“"]/.test(t)) return line;
    var prevBlank = (i === 0) || lines[i - 1].trim() === '';
    var nextBlank = (i === lines.length - 1) || lines[i + 1].trim() === '';
    if (!prevBlank || !nextBlank) return line;
    count++;
    return '## ' + t;
  });
  return { text: out.join('\n'), count: count };
}

function wordCount(s) {
  var t = String(s).trim();
  return t ? t.split(/\s+/).length : 0;
}

async function loadChapters(id) {
  var v = await idbGet(id);
  if (!v) return null;
  if (typeof v === 'string') return parseMarkup(v);
  return (v.chapters && v.chapters.length) ? v.chapters : null;
}
function saveChapters(id, chapters) {
  return idbSet(id, { chapters: chapters }).then(function () { scheduleSync(); });
}

var readerToc = [];
function renderBook(chapters) {
  var frag = document.createDocumentFragment();
  readerToc = [];
  chapters.forEach(function (ch) {
    if (ch.title) {
      var h2 = el('h2', 'chapter-title', ch.title);
      frag.appendChild(h2);
      readerToc.push({ el: h2, title: ch.title, level: 1 });
    }
    parseBody(ch.body).forEach(function (b) {
      if (b.type === 'h') {
        var h3 = el('h3', 'sub-title', b.text);
        frag.appendChild(h3);
        readerToc.push({ el: h3, title: b.text, level: 2 });
      } else {
        frag.appendChild(el('p', '', b.text));
      }
    });
  });
  $('reader-body').appendChild(frag);
}

function openToc() {
  var list = $('toc-list');
  list.textContent = '';
  if (readerToc.length === 0) {
    list.appendChild(el('p', 'hint', 'This book has no chapters yet. Use Edit in your library to organize it.'));
  }
  readerToc.forEach(function (item) {
    var b = el('button', 'toc-item' + (item.level === 2 ? ' sub' : ''), item.title);
    b.type = 'button';
    b.addEventListener('click', function () {
      $('modal-toc').style.display = 'none';
      var sc = $('reader-scroll');
      var top = item.el.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      sc.scrollTop = Math.max(0, top - 12);
      if (reader) { reader.lastActivity = Date.now(); reader.pct = getPct(); }
    });
    list.appendChild(b);
  });
  $('modal-toc').style.display = 'flex';
}

async function openBook(id, startPct) {
  var book = state.books.find(function (b) { return b.id === id; });
  if (!book) return;
  if (reader) await closeReader(true);

  showView('reader');
  $('reader-title').textContent = book.title;
  $('reader-body').textContent = '';
  $('reader-body').style.display = 'block';
  $('reader-reattach').style.display = 'none';
  $('reader-scroll').scrollTop = 0;
  applyFontSize();

  var chapters = null;
  try { chapters = await loadChapters(id); } catch (e) { chapters = null; }
  if (!chapters) {
    $('reader-body').style.display = 'none';
    $('reader-reattach').style.display = 'block';
    hideBm();
    $('reader-reattach').setAttribute('data-book', id);
    var holdN = deviceList().filter(function (d) { return !d.isMe && deviceHas(d, id, { sizes: {} }); })
      .map(function (d) { return d.name; });
    $('reattach-note').textContent = holdN.length
      ? "This book's text isn't on this device. It is saved on " + holdN.join(' and ') + ". Open DoomReader on " + (holdN.length === 1 ? 'that device' : 'one of those devices') + " to read it."
      : "This book's text isn't saved on any device yet.";
    return;
  }

  renderBook(chapters);
  paintHighlights(book.id);

  var useBm = (startPct === null || startPct === undefined) && !!book.bookmark_quote;
  var pct = (startPct !== null && startPct !== undefined) ? startPct
    : (useBm && book.bookmark_pct != null ? Number(book.bookmark_pct) : (Number(book.progress_pct) || 0));
  requestAnimationFrame(function () {
    if (!(useBm && scrollToBookmark())) setScrollPct(pct);
    if (reader) reader.pct = getPct();
  });
  bmMode = false;

  reader = {
    book: book,
    startedAt: new Date().toISOString(),
    seconds: 0,
    pctStart: pct,
    pct: pct,
    lastActivity: Date.now(),
    lastSaved: pct,
    timer: null
  };
  reader.timer = setInterval(readerTick, 1000);
  showBmBar();

  if (book.status === 'queued') updateBook(book.id, { status: 'reading', last_read_at: new Date().toISOString() });
}

function readerTick() {
  if (!reader) return;
  if (document.visibilityState === 'visible' && Date.now() - reader.lastActivity < 120000) reader.seconds++;
  if (reader.seconds > 0 && reader.seconds % 20 === 0) persistProgress(reader);
}

var scrollThrottle = 0;
function onReaderScroll() {
  if (!reader) return;
  reader.lastActivity = Date.now();
  var now = Date.now();
  if (now - scrollThrottle < 300) return;
  scrollThrottle = now;
  reader.pct = getPct();
}

async function updateBook(id, patch) {
  var b = state.books.find(function (x) { return x.id === id; });
  if (b) Object.keys(patch).forEach(function (k) { b[k] = patch[k]; });
  var res = await sb.from('books').update(patch).eq('id', id);
  return !res.error;
}

async function persistProgress(r) {
  r.pct = getPct() || r.pct;
  if (r.book.bookmark_quote) {
    /* With a bookmark, your place is the bookmark, not how far you scrolled. */
    await updateBook(r.book.id, { last_read_at: new Date().toISOString() });
    return;
  }
  if (Math.abs(r.pct - r.lastSaved) < 0.1) return;
  r.lastSaved = r.pct;
  await updateBook(r.book.id, {
    progress_pct: r.pct,
    last_read_at: new Date().toISOString(),
    status: r.pct >= 98 ? 'finished' : 'reading'
  });
}

async function closeReader(skipNav) {
  if (!reader) {
    if (!skipNav) showView(state.returnView || 'library');
    return;
  }
  var r = reader;
  reader = null;
  clearInterval(r.timer);
  hideHlBtn();
  hideBm();
  r.pct = getPct() || r.pct;
  await persistProgress(r);
  if (r.seconds >= 10) {
    var row = {
      user_id: currentUser.id,
      book_id: r.book.id,
      started_at: r.startedAt,
      seconds: r.seconds,
      pct_start: r.pctStart,
      pct_end: r.pct
    };
    var res = await sb.from('reading_sessions').insert(row);
    if (!res.error) state.sessions.push({ book_id: row.book_id, started_at: row.started_at, seconds: row.seconds });
  }
  state.feedDirty = true;
  if (!skipNav) showView(state.returnView || 'library');
}

/* ---------- bookmark: where I left off ---------- */
var bmMode = false;

function hideBm() { bmMode = false; var b = $('bm-bar'); if (b) b.style.display = 'none'; }

function showBmBar() {
  var bar = $('bm-bar');
  var book = currentBmBook();
  bar.textContent = '';
  bar.style.display = 'flex';
  if (bmMode) {
    bar.appendChild(el('span', 'bm-hint', 'Tap the word where you stopped'));
    if (book && book.bookmark_quote) {
      var rm = el('button', 'bm-btn', 'Remove');
      rm.type = 'button';
      rm.addEventListener('click', removeBookmark);
      bar.appendChild(rm);
    }
    var cn = el('button', 'bm-btn', 'Cancel');
    cn.type = 'button';
    cn.addEventListener('click', function () { bmMode = false; showBmBar(); });
    bar.appendChild(cn);
    return;
  }
  var go = el('button', 'bm-btn bm-main', 'Bookmark');
  go.type = 'button';
  go.addEventListener('click', function () { bmMode = true; showBmBar(); });
  bar.appendChild(go);
  if (book && book.bookmark_quote) {
    var jump = el('button', 'bm-btn', 'Go to mine');
    jump.type = 'button';
    jump.addEventListener('click', function () { if (!scrollToBookmark()) toast("Couldn't find the bookmark in the text."); });
    bar.appendChild(jump);
  }
}

function currentBmBook() {
  var id = reader ? reader.book.id : null;
  if (!id) return null;
  return state.books.filter(function (b) { return b.id === id; })[0] || reader.book;
}

function caretAt(x, y) {
  var r = null;
  if (document.caretRangeFromPoint) r = document.caretRangeFromPoint(x, y);
  else if (document.caretPositionFromPoint) {
    var p = document.caretPositionFromPoint(x, y);
    if (p) { r = document.createRange(); r.setStart(p.offsetNode, p.offset); }
  }
  return r && r.startContainer.nodeType === 3 ? { node: r.startContainer, off: r.startOffset } : null;
}

async function placeBookmark(x, y) {
  var body = $('reader-body');
  var c = caretAt(x, y);
  if (!c || !body.contains(c.node)) return toast('Tap on a word in the text.');
  var v = c.node.nodeValue, e = c.off;
  while (e < v.length && !/\s/.test(v.charAt(e))) e++;
  var ix = buildTextIndex(body), hit = null;
  ix.nodes.forEach(function (n) { if (n.node === c.node) hit = n; });
  if (!hit) return toast('Tap on a word in the text.');
  var m = collapseNode(v, hit.drop), k = 0;
  while (k < m.idx.length && m.idx[k] < e) k++;
  var posEnd = hit.start + Math.min(k, hit.len);
  var anchor = ix.full.slice(Math.max(0, posEnd - 60), posEnd).trim();
  if (anchor.length < 2) return toast('Tap on a word in the text.');
  var pct = reader.pct;
  try {
    var rg = document.createRange();
    rg.setStart(c.node, Math.min(e, v.length)); rg.collapse(true);
    var rect = rg.getBoundingClientRect(), sc = $('reader-scroll'), max = scrollMax();
    if (max > 0 && rect.height) pct = Math.round(Math.min(100, Math.max(0, (sc.scrollTop + rect.top - sc.getBoundingClientRect().top) / max * 100)) * 10) / 10;
  } catch (err) { /* keep reader.pct */ }
  var patch = { bookmark_quote: anchor, bookmark_pct: pct, progress_pct: pct, last_read_at: new Date().toISOString(), status: pct >= 98 ? 'finished' : 'reading' };
  var res = await sb.from('books').update(patch).eq('id', reader.book.id);
  if (res.error) {
    bmMode = false; showBmBar();
    return toast("Couldn't save the bookmark: " + res.error.message + '. Run the bookmark SQL step in Supabase.');
  }
  var b = state.books.filter(function (x) { return x.id === reader.book.id; })[0];
  if (b) Object.keys(patch).forEach(function (kk) { b[kk] = patch[kk]; });
  reader.book = b || reader.book;
  reader.pct = pct;
  reader.lastSaved = pct;
  bmMode = false;
  state.feedDirty = true;
  paintBookmark(reader.book.id);
  showBmBar();
  toast('Bookmark saved. Continue starts here.');
}

async function removeBookmark() {
  if (!reader) return;
  var res = await sb.from('books').update({ bookmark_quote: null, bookmark_pct: null }).eq('id', reader.book.id);
  if (res.error) return toast("Couldn't remove it: " + res.error.message);
  var b = state.books.filter(function (x) { return x.id === reader.book.id; })[0];
  if (b) { b.bookmark_quote = null; b.bookmark_pct = null; }
  reader.book = b || reader.book;
  bmMode = false;
  paintBookmark(reader.book.id);
  showBmBar();
  toast('Bookmark removed. Progress follows scrolling again.');
}

function paintBookmark(bookId) {
  var body = $('reader-body');
  Array.prototype.forEach.call(body.querySelectorAll('span.bm'), function (m) { m.parentNode.removeChild(m); });
  var book = state.books.filter(function (b) { return b.id === bookId; })[0];
  if (!book || !book.bookmark_quote) return;
  var ix = buildTextIndex(body), needle = book.bookmark_quote;
  var hits = [], p = ix.full.indexOf(needle);
  while (p !== -1 && hits.length < 200) { hits.push(p); p = ix.full.indexOf(needle, p + 1); }
  if (!hits.length) return;
  var want = Number(book.bookmark_pct) || 0, best = hits[0], bestD = Infinity;
  hits.forEach(function (x) {
    var d = Math.abs((x + needle.length) / Math.max(1, ix.full.length) * 100 - want);
    if (d < bestD) { bestD = d; best = x; }
  });
  var end = best + needle.length, target = null;
  ix.nodes.forEach(function (n) { if (!target && end > n.start && end <= n.start + n.len) target = n; });
  if (!target) return;
  var m = collapseNode(target.node.nodeValue, target.drop);
  var oe = m.idx[end - target.start - 1];
  if (oe === undefined) return;
  var tn = target.node;
  if (oe + 1 < tn.nodeValue.length) tn.splitText(oe + 1);
  var span = document.createElement('span');
  span.className = 'bm';
  span.setAttribute('aria-hidden', 'true');
  tn.parentNode.insertBefore(span, tn.nextSibling);
}

function scrollToBookmark() {
  var m = $('reader-body').querySelector('span.bm');
  if (!m) return false;
  var sc = $('reader-scroll');
  var top = m.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  sc.scrollTop = Math.max(0, top - sc.clientHeight * 0.35);
  if (reader) { reader.lastActivity = Date.now(); reader.pct = getPct(); }
  return true;
}

/* ---------- how to use guide (add the newest feature at the TOP) ---------- */
var HELP_TOPICS = [
  { title: 'Bookmark: where I left off', isNew: true, steps: [
    'Open a book and tap Bookmark (bottom right).',
    'Tap the word where you stopped. A pink ribbon appears there.',
    'Next time, Continue opens right at your ribbon, even if you skipped ahead before.',
    'Skimmed or spoiled yourself further on? That no longer moves your place. Only the bookmark does.',
    'To move it: tap Bookmark again and tap a new word. To remove it: Bookmark, then Remove.',
    'Tap Go to mine to jump back to the ribbon from anywhere in the book.'
  ] },
  { title: 'Add a note to a highlight', isNew: true, steps: [
    'Select some text in the reader.',
    'Tap the green ADD NOTE button. The text is highlighted in your last color and a box opens.',
    'Type your note and tap Add to thread. You can keep adding notes to build a thread with yourself.',
    'A small badge after the highlight shows how many notes it has. Tap the highlight to reopen them.',
    'Your notes also show on the highlight card in your Feed.'
  ] },
  { title: 'Highlight in colors', steps: [
    'Select text, then tap a color dot: yellow, pink, red, blue, purple, green, or orange.',
    'To change the color later, tap the highlight and pick a different dot.',
    'Feed cards for highlights use the same color.'
  ] },
  { title: 'Devices and where my books are saved', steps: [
    'Each time you open DoomReader, choose which device you are on.',
    'Book text is saved only on the devices you add it to. Titles, progress, highlights and notes show everywhere.',
    'If a book is blank, you are on a device without its text. Use Add text here, or switch devices.',
    'Rename your four devices any time in Settings (tap the device name at the top).'
  ] }
];

function openHelp() {
  var box = $('help-list');
  box.textContent = '';
  HELP_TOPICS.forEach(function (t, i) {
    var d = document.createElement('details');
    d.className = 'help-item';
    if (i === 0) d.open = true;
    var sm = document.createElement('summary');
    sm.appendChild(document.createTextNode(t.title));
    if (t.isNew) sm.appendChild(el('span', 'new-tag', 'NEW'));
    d.appendChild(sm);
    var ol = document.createElement('ol');
    t.steps.forEach(function (st) { ol.appendChild(el('li', null, st)); });
    d.appendChild(ol);
    box.appendChild(d);
  });
  $('modal-help').style.display = 'flex';
}

/* ---------- highlights: colors, painting, comments ---------- */
var HL_COLORS = [
  { key: 'yellow', name: 'Yellow', hex: '#ffe600' },
  { key: 'pink', name: 'Pink', hex: '#ff5ec8' },
  { key: 'red', name: 'Red', hex: '#ff4a4a' },
  { key: 'blue', name: 'Blue', hex: '#4aa8ff' },
  { key: 'purple', name: 'Purple', hex: '#b27bff' },
  { key: 'green', name: 'Green', hex: '#39ff14' },
  { key: 'orange', name: 'Orange', hex: '#ff8a1f' }
];
var lastHlColor = 'yellow';
try { lastHlColor = localStorage.getItem('dr_hlcolor') || 'yellow'; } catch (e) { /* ignore */ }
function validColor(k) { return HL_COLORS.some(function (c) { return c.key === k; }); }
if (!validColor(lastHlColor)) lastHlColor = 'yellow';
function hlColor(h) { return validColor(h.color) ? h.color : 'yellow'; }
function hlById(id) { return state.highlights.filter(function (h) { return h.id === id; })[0] || null; }
function commentsFor(id) { return state.comments.filter(function (c) { return c.highlight_id === id; }); }

function hideHlBtn() { $('hl-bar').style.display = 'none'; }

function buildHlBar() {
  var bar = $('hl-bar');
  bar.textContent = '';
  bar.appendChild(el('span', 'hl-bar-label', 'Highlight'));
  HL_COLORS.forEach(function (c) {
    var b = el('button', 'hl-dot' + (c.key === lastHlColor ? ' last' : ''));
    b.type = 'button';
    b.style.background = c.hex;
    b.setAttribute('aria-label', 'Highlight in ' + c.name.toLowerCase());
    b.title = c.name;
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function () { saveHighlight(c.key); });
    bar.appendChild(b);
  });
  var nb = el('button', 'hl-note-btn', 'Add note');
  nb.type = 'button';
  nb.addEventListener('mousedown', function (e) { e.preventDefault(); });
  nb.addEventListener('click', function () { saveHighlight(lastHlColor, true); });
  bar.appendChild(nb);
}

function selectedReaderText() {
  var sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  var body = $('reader-body');
  if (!body.contains(sel.anchorNode) || !body.contains(sel.focusNode)) return null;
  var t = sel.toString().replace(/\s+/g, ' ').trim();
  return t.length >= 3 ? t : null;
}

function onSelectionChange() {
  if (!reader) return hideHlBtn();
  $('hl-bar').style.display = selectedReaderText() ? 'flex' : 'none';
}

async function saveHighlight(colorKey, thenNote) {
  if (!reader) return;
  var quote = selectedReaderText();
  if (!quote) return hideHlBtn();
  if (quote.length > MAX_QUOTE_CHARS) return toast('Too long. Select ' + MAX_QUOTE_CHARS + ' characters or fewer.');
  colorKey = validColor(colorKey) ? colorKey : lastHlColor;
  var sel = window.getSelection();
  var pos = reader.pct;
  try {
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    var sc = $('reader-scroll');
    var top = sc.scrollTop + rect.top - sc.getBoundingClientRect().top;
    var max = scrollMax();
    if (max > 0) pos = Math.round(Math.min(100, Math.max(0, top / max * 100)) * 10) / 10;
  } catch (e) { /* keep reader.pct */ }
  var row = { user_id: currentUser.id, book_id: reader.book.id, quote: quote, position_pct: pos, color: colorKey };
  var res = await sb.from('highlights').insert(row).select().single();
  var needSql = false;
  if (res.error && /color/i.test(res.error.message || '')) {
    delete row.color;
    res = await sb.from('highlights').insert(row).select().single();
    needSql = true;
  }
  if (res.error || !res.data) return toast("Couldn't save: " + (res.error ? res.error.message : 'try again'));
  if (!res.data.color) res.data.color = needSql ? 'yellow' : colorKey;
  state.highlights.unshift(res.data);
  state.feedDirty = true;
  lastHlColor = colorKey;
  try { localStorage.setItem('dr_hlcolor', colorKey); } catch (e) { /* ignore */ }
  buildHlBar();
  if (window.getSelection) window.getSelection().removeAllRanges();
  hideHlBtn();
  paintHighlights(reader.book.id);
  if (thenNote) {
    openHlPanel(res.data.id, 'reader');
    setTimeout(function () { $('hl-new').focus(); }, 50);
    if (needSql) showMsg('hl-msg', 'Saved in yellow. Run the highlight SQL step to use colors.', 'error');
    return;
  }
  toast(needSql ? 'Saved in yellow. Run the highlight SQL step to use colors.' : 'Highlight saved. Tap it to add a note.');
}

/* ----- painting highlights into the reader text ----- */
function collapseNode(value, dropLead) {
  var out = '', idx = [], prevSpace = !!dropLead;
  for (var i = 0; i < value.length; i++) {
    var ch = value.charAt(i);
    if (/\s/.test(ch)) {
      if (!prevSpace) { out += ' '; idx.push(i); prevSpace = true; }
    } else { out += ch; idx.push(i); prevSpace = false; }
  }
  return { piece: out, idx: idx };
}

function buildTextIndex(body) {
  var walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
  var nodes = [], full = '', lastBlock = null, tn;
  while ((tn = walker.nextNode())) {
    var blk = tn.parentNode && tn.parentNode.closest ? tn.parentNode.closest('p,h2,h3') : null;
    var piece = tn.nodeValue.replace(/\s+/g, ' ');
    if (blk !== lastBlock && full.length && full.charAt(full.length - 1) !== ' ') full += ' ';
    var drop = full.length > 0 && full.charAt(full.length - 1) === ' ' && piece.charAt(0) === ' ';
    if (drop) piece = piece.slice(1);
    lastBlock = blk;
    if (!piece.length) continue;
    nodes.push({ node: tn, start: full.length, len: piece.length, drop: drop });
    full += piece;
  }
  return { nodes: nodes, full: full };
}

function paintOne(body, h) {
  var needle = String(h.quote || '').replace(/\s+/g, ' ').trim();
  if (!needle) return;
  var ix = buildTextIndex(body);
  var hits = [], p = ix.full.indexOf(needle);
  while (p !== -1 && hits.length < 200) { hits.push(p); p = ix.full.indexOf(needle, p + 1); }
  if (!hits.length) return;
  var want = Number(h.position_pct) || 0, best = hits[0], bestD = Infinity;
  hits.forEach(function (x) {
    var d = Math.abs(x / Math.max(1, ix.full.length) * 100 - want);
    if (d < bestD) { bestD = d; best = x; }
  });
  var s = best, e = best + needle.length, segs = [];
  ix.nodes.forEach(function (n) {
    var a = Math.max(s, n.start), b = Math.min(e, n.start + n.len);
    if (a >= b) return;
    var m = collapseNode(n.node.nodeValue, n.drop);
    var oa = m.idx[a - n.start], ob = m.idx[b - n.start - 1] + 1;
    if (oa === undefined || ob === undefined) return;
    if (!n.node.nodeValue.slice(oa, ob).trim()) return;
    segs.push({ tn: n.node, a: oa, b: ob });
  });
  var nNotes = commentsFor(h.id).length;
  for (var i = segs.length - 1; i >= 0; i--) {
    var sg = segs[i], tn = sg.tn;
    if (sg.b < tn.nodeValue.length) tn.splitText(sg.b);
    var target = sg.a > 0 ? tn.splitText(sg.a) : tn;
    var mark = document.createElement('mark');
    mark.className = 'hl hl-' + hlColor(h);
    mark.setAttribute('data-h', h.id);
    if (i === segs.length - 1 && nNotes) { mark.classList.add('has-note'); mark.setAttribute('data-n', String(nNotes)); }
    target.parentNode.replaceChild(mark, target);
    mark.appendChild(target);
  }
}

function paintHighlights(bookId) {
  var body = $('reader-body');
  Array.prototype.forEach.call(body.querySelectorAll('mark.hl'), function (m) {
    var par = m.parentNode;
    while (m.firstChild) par.insertBefore(m.firstChild, m);
    par.removeChild(m);
  });
  Array.prototype.forEach.call(body.querySelectorAll('span.bm'), function (m) { m.parentNode.removeChild(m); });
  body.normalize();
  state.highlights.filter(function (h) { return h.book_id === bookId; })
    .sort(function (a, b) { return new Date(a.created_at) - new Date(b.created_at); })
    .forEach(function (h) { paintOne(body, h); });
  paintBookmark(bookId);
}

/* ----- highlight panel: color, comments, thread ----- */
var hlPanel = null;

function openHlPanel(id, from) {
  if (!hlById(id)) return;
  hlPanel = { id: id, from: from, changed: false, editing: null };
  $('hl-new').value = '';
  clearMsg('hl-msg');
  renderHlPanel();
  $('modal-hl').style.display = 'flex';
}

function renderHlPanel() {
  var h = hlById(hlPanel.id);
  if (!h) return closeHlPanel();
  var q = $('hl-quote');
  q.className = 'hl-quote hc-' + hlColor(h);
  q.textContent = '“' + h.quote + '”';
  var bk = state.books.filter(function (b) { return b.id === h.book_id; })[0];
  $('hl-book').textContent = bk ? bk.title + (bk.author ? ' · ' + bk.author : '') : '';
  var colors = $('hl-colors');
  colors.textContent = '';
  HL_COLORS.forEach(function (c) {
    var b = el('button', 'hl-dot' + (c.key === hlColor(h) ? ' current' : ''));
    b.type = 'button';
    b.style.background = c.hex;
    b.setAttribute('aria-label', 'Change to ' + c.name.toLowerCase());
    b.title = c.name;
    b.addEventListener('click', function () { changeHlColor(c.key); });
    colors.appendChild(b);
  });
  var list = commentsFor(h.id);
  $('hl-thread-title').textContent = list.length ? 'Thread (' + list.length + ')' : 'Thread';
  var box = $('hl-thread');
  box.textContent = '';
  if (!list.length) {
    box.appendChild(el('p', 'hint', 'No comments yet. Write one below, then keep adding to build a thread with yourself.'));
  }
  list.forEach(function (cm) {
    var row = el('div', 'cm');
    row.appendChild(el('div', 'cm-meta', fmtWhen(cm.created_at) + (cm.updated_at ? '  ·  edited' : '')));
    if (hlPanel.editing === cm.id) {
      var ta = document.createElement('textarea');
      ta.rows = 3;
      ta.value = cm.body;
      ta.maxLength = 2000;
      row.appendChild(ta);
      var ea = el('div', 'cm-actions');
      var sv = el('button', 'btn-mini', 'Save');
      sv.type = 'button';
      sv.addEventListener('click', function () { saveCommentEdit(cm, ta.value); });
      var cn = el('button', 'btn-mini', 'Cancel');
      cn.type = 'button';
      cn.addEventListener('click', function () { hlPanel.editing = null; renderHlPanel(); });
      ea.appendChild(sv); ea.appendChild(cn);
      row.appendChild(ea);
    } else {
      row.appendChild(el('div', 'cm-body', cm.body));
      var acts = el('div', 'cm-actions');
      var ed = el('button', 'btn-mini', 'Edit');
      ed.type = 'button';
      ed.addEventListener('click', function () { hlPanel.editing = cm.id; renderHlPanel(); });
      var dl = el('button', 'btn-mini', 'Delete');
      dl.type = 'button';
      dl.addEventListener('click', function () { deleteComment(cm); });
      acts.appendChild(ed); acts.appendChild(dl);
      row.appendChild(acts);
    }
    box.appendChild(row);
  });
  if (state.commentError) showMsg('hl-msg', "Comments aren't working yet: " + state.commentError + '. Run the highlight SQL step in Supabase.', 'error');
}

function closeHlPanel() {
  $('modal-hl').style.display = 'none';
  var p = hlPanel;
  hlPanel = null;
  if (p && p.changed) {
    if (reader) paintHighlights(reader.book.id);
    state.feedDirty = true;
    if (state.view === 'feed') renderFeed();
    else if (state.view === 'library') renderLibrary();
  }
}

async function addHlComment() {
  if (!hlPanel) return;
  var body = $('hl-new').value.trim();
  if (!body) return showMsg('hl-msg', 'Write a comment first.', 'error');
  if (body.length > 2000) return showMsg('hl-msg', 'That comment is too long (limit 2000 characters).', 'error');
  var res = await sb.from('highlight_comments').insert({ user_id: currentUser.id, highlight_id: hlPanel.id, body: body }).select().single();
  if (res.error || !res.data) return showMsg('hl-msg', "Couldn't save the comment: " + (res.error ? res.error.message : 'no response'), 'error');
  state.comments.push(res.data);
  state.commentError = null;
  hlPanel.changed = true;
  $('hl-new').value = '';
  clearMsg('hl-msg');
  renderHlPanel();
  var t = $('hl-thread');
  t.scrollTop = t.scrollHeight;
  $('hl-new').focus();
}

async function saveCommentEdit(cm, text) {
  text = text.trim();
  if (!text) return showMsg('hl-msg', 'A comment cannot be empty. Delete it instead.', 'error');
  var res = await sb.from('highlight_comments').update({ body: text, updated_at: new Date().toISOString() }).eq('id', cm.id).select().single();
  if (res.error || !res.data) return showMsg('hl-msg', "Couldn't save the change: " + (res.error ? res.error.message : 'no response'), 'error');
  state.comments = state.comments.map(function (x) { return x.id === cm.id ? res.data : x; });
  hlPanel.editing = null;
  hlPanel.changed = true;
  clearMsg('hl-msg');
  renderHlPanel();
}

async function deleteComment(cm) {
  if (!window.confirm('Delete this comment?')) return;
  var res = await sb.from('highlight_comments').delete().eq('id', cm.id);
  if (res.error) return showMsg('hl-msg', "Couldn't delete it: " + res.error.message, 'error');
  state.comments = state.comments.filter(function (x) { return x.id !== cm.id; });
  hlPanel.changed = true;
  renderHlPanel();
}

async function changeHlColor(key) {
  var h = hlById(hlPanel.id);
  if (!h || hlColor(h) === key) return;
  var res = await sb.from('highlights').update({ color: key }).eq('id', h.id).select().single();
  if (res.error) return showMsg('hl-msg', "Couldn't change the color: " + res.error.message + '. Run the highlight SQL step in Supabase.', 'error');
  h.color = key;
  hlPanel.changed = true;
  clearMsg('hl-msg');
  if (reader) paintHighlights(reader.book.id);
  renderHlPanel();
}

async function deleteHighlight() {
  var h = hlById(hlPanel.id);
  if (!h) return;
  if (!window.confirm('Delete this highlight and its whole thread of comments?')) return;
  var res = await sb.from('highlights').delete().eq('id', h.id);
  if (res.error) return showMsg('hl-msg', "Couldn't delete it: " + res.error.message, 'error');
  state.highlights = state.highlights.filter(function (x) { return x.id !== h.id; });
  state.comments = state.comments.filter(function (x) { return x.highlight_id !== h.id; });
  hlPanel.changed = true;
  if (reader) paintHighlights(reader.book.id);
  closeHlPanel();
  toast('Highlight deleted');
}

/* ============================================================
   Edit book: details, chapters, organize by chapters
   ============================================================ */
var editing = null;

async function openEdit(book) {
  var chapters = null;
  try { chapters = await loadChapters(book.id); } catch (e) { chapters = null; }
  editing = { book: book, chapters: chapters || [], hasText: !!chapters };
  $('edit-title').value = book.title;
  $('edit-author').value = book.author || '';
  clearMsg('edit-msg');
  showView('edit');
  renderEdit();
}

async function persistChapters() {
  try {
    await saveChapters(editing.book.id, editing.chapters);
    editing.hasText = editing.chapters.length > 0;
    state.feedDirty = true;
    return true;
  } catch (e) {
    toast("Your browser wouldn't store that. Free up space and try again.");
    return false;
  }
}

function renderEdit() {
  var note = $('edit-note');
  note.textContent = editing.hasText
    ? 'Chapters are stored on this device. Tap Edit text to change a chapter, or Organize by chapters to split one big paste into chapters.'
    : "This book's text isn't on this device yet. Tap Add text to this device to paste the whole book, or add it chapter by chapter below.";
  $('btn-edit-addtext').style.display = editing.hasText ? 'none' : '';
  var box = $('edit-chapters');
  box.textContent = '';
  if (editing.chapters.length === 0) {
    box.appendChild(el('p', 'empty', 'No chapters yet.'));
    return;
  }
  editing.chapters.forEach(function (ch, i) {
    var row = el('div', 'ch-row');
    var top = el('div', 'ch-top');
    top.appendChild(el('span', 'ch-num', String(i + 1)));
    var inp = el('input');
    inp.type = 'text';
    inp.maxLength = 200;
    inp.value = ch.title;
    inp.placeholder = 'Untitled section';
    inp.addEventListener('change', async function () {
      ch.title = inp.value.trim();
      await persistChapters();
    });
    top.appendChild(inp);
    row.appendChild(top);
    row.appendChild(el('div', 'book-meta', wordCount(ch.body).toLocaleString() + ' words'));
    var acts = el('div', 'book-actions');
    function mk(label, fn) {
      var b = el('button', 'btn btn-small', label);
      b.type = 'button';
      b.addEventListener('click', fn);
      acts.appendChild(b);
      return b;
    }
    mk('Edit text', function () { openChapterModal(i); });
    mk('Up', async function () {
      if (i === 0) return;
      var t = editing.chapters[i - 1]; editing.chapters[i - 1] = ch; editing.chapters[i] = t;
      await persistChapters(); renderEdit();
    });
    mk('Down', async function () {
      if (i === editing.chapters.length - 1) return;
      var t = editing.chapters[i + 1]; editing.chapters[i + 1] = ch; editing.chapters[i] = t;
      await persistChapters(); renderEdit();
    });
    mk('Delete', async function () {
      if (!window.confirm('Delete this chapter from this device? This cannot be undone.')) return;
      editing.chapters.splice(i, 1);
      await persistChapters(); renderEdit();
    });
    row.appendChild(acts);
    box.appendChild(row);
  });
}

async function saveDetails() {
  var title = $('edit-title').value.trim();
  var author = $('edit-author').value.trim();
  if (!title) return showMsg('edit-msg', 'Add a title.', 'error');
  var ok = await updateBook(editing.book.id, { title: title, author: author || null });
  if (!ok) return showMsg('edit-msg', "Couldn't save. Check your connection and try again.", 'error');
  state.feedDirty = true;
  showMsg('edit-msg', 'Saved.', 'success');
}

async function closeEdit() {
  editing = null;
  showView('library');
}

/* ---------- chapter editor ---------- */
var chapterIndex = null;
function openChapterModal(index) {
  chapterIndex = index;
  clearMsg('ch-msg');
  if (index === null) {
    $('ch-modal-head').textContent = 'Add a chapter';
    $('ch-title').value = '';
    $('ch-body').value = '';
  } else {
    var ch = editing.chapters[index];
    $('ch-modal-head').textContent = 'Edit chapter';
    $('ch-title').value = ch.title;
    $('ch-body').value = ch.body;
  }
  $('ch-body').dispatchEvent(new Event('input'));
  $('modal-chapter').style.display = 'flex';
}

async function saveChapterModal() {
  var title = $('ch-title').value.trim();
  var body = $('ch-body').value.replace(/\r\n/g, '\n').trim();
  if (!body) return showMsg('ch-msg', 'Paste or type the chapter text first.', 'error');
  if (body.length > MAX_BOOK_CHARS) return showMsg('ch-msg', 'That chapter is too long.', 'error');
  if (chapterIndex === null) {
    if (!title) title = 'Chapter ' + (editing.chapters.length + 1);
    editing.chapters.push({ title: title, body: body });
  } else {
    editing.chapters[chapterIndex] = { title: title, body: body };
  }
  if (!(await persistChapters())) return;
  $('modal-chapter').style.display = 'none';
  renderEdit();
  toast('Chapter saved');
}

function runDetectSub(textId, msgId) {
  var r = detectSubheadings($(textId).value);
  $(textId).value = r.text;
  $(textId).dispatchEvent(new Event('input'));
  showMsg(msgId, r.count > 0
    ? r.count + ' line' + (r.count === 1 ? '' : 's') + ' marked as subheadings (they now start with ##). Check them, delete the ## from any that are wrong, then save.'
    : 'No likely subheadings found. You can type ## at the start of any line to make it a subheading.', 'info');
}

/* ---------- organize by chapters ---------- */
function openOrganize() {
  $('org-text').value = serializeChapters(editing.chapters);
  $('org-text').dispatchEvent(new Event('input'));
  clearMsg('org-msg');
  $('modal-organize').style.display = 'flex';
}

function runDetectChapters(textId, msgId) {
  var r = detectChapterHeadings($(textId).value);
  $(textId).value = r.text;
  $(textId).dispatchEvent(new Event('input'));
  showMsg(msgId, r.count > 0
    ? r.count + ' chapter heading' + (r.count === 1 ? '' : 's') + ' found (they now start with #). Check them, fix any, then save.'
    : 'No lines like "Chapter 1" or "Part II" found. Type # at the start of each chapter title line yourself.', 'info');
}

async function applyOrganize() {
  var text = $('org-text').value.trim();
  if (!text) return showMsg('org-msg', 'There is no text to organize.', 'error');
  if (text.length > MAX_BOOK_CHARS) return showMsg('org-msg', 'That is too long for one book (limit about 3 million characters).', 'error');
  var chapters = parseMarkup(text);
  editing.chapters = chapters;
  if (!(await persistChapters())) return;
  $('modal-organize').style.display = 'none';
  renderEdit();
  toast(chapters.length + (chapters.length === 1 ? ' chapter' : ' chapters'));
}

/* ============================================================
   Wire up
   ============================================================ */
/* ============================================================
   Find, replace and marked-lines tools (for the chapter dialogs)
   ============================================================ */
function listMarks(text) {
  var out = [];
  var pos = 0;
  text.split('\n').forEach(function (line) {
    var m = line.match(/^(#{1,2})(?!#)\s*(.*)$/);
    if (m && m[2].trim()) out.push({ start: pos, end: pos + line.length, level: m[1].length, text: m[2].trim() });
    pos += line.length + 1;
  });
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function jumpTo(ta, start, end) {
  var max = Math.max(0, ta.scrollHeight - ta.clientHeight);
  ta.scrollTop = Math.max(0, Math.min(max, max * (start / Math.max(1, ta.value.length)) - ta.clientHeight / 2));
  ta.focus();
  ta.setSelectionRange(start, end);
}

function setupTextTools(p, taId) {
  var ta = $(taId), find = $(p + '-find'), repl = $(p + '-repl');
  var msg = $(p + '-find-msg'), marks = $(p + '-marks'), timer = null;

  function setValue(v, selStart, selEnd) {
    var top = ta.scrollTop;
    ta.value = v;
    ta.scrollTop = top;
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd);
    renderMarks();
  }

  function renderMarks() {
    var list = listMarks(ta.value);
    marks.textContent = '';
    var ch = list.filter(function (m) { return m.level === 1; }).length;
    var sub = list.length - ch;
    marks.appendChild(el('div', 'hint', list.length === 0
      ? 'No marked lines yet. Lines starting with # are chapters and ## are subheadings.'
      : 'Marked lines: ' + ch + (ch === 1 ? ' chapter, ' : ' chapters, ') + sub + (sub === 1 ? ' subheading' : ' subheadings') + '. Tap Go to jump to one.'));
    var shown = list.slice(0, 200);
    shown.forEach(function (m) {
      var row = el('div', 'mark-row');
      row.appendChild(el('span', 'mark-tag' + (m.level === 2 ? ' sub' : ''), m.level === 1 ? 'CH' : 'SUB'));
      row.appendChild(el('span', 'mark-text', m.text));
      function mk(label, fn) {
        var b = el('button', 'btn-mini', label);
        b.type = 'button';
        b.addEventListener('click', fn);
        row.appendChild(b);
      }
      mk('Go', function () { jumpTo(ta, m.start, m.end); });
      mk('Unmark', function () {
        var v = ta.value;
        setValue(v.slice(0, m.start) + m.text + v.slice(m.end));
      });
      mk(m.level === 1 ? 'To ##' : 'To #', function () {
        var v = ta.value;
        setValue(v.slice(0, m.start) + (m.level === 1 ? '## ' : '# ') + m.text + v.slice(m.end));
      });
      marks.appendChild(row);
    });
    if (list.length > shown.length) {
      marks.appendChild(el('div', 'hint', 'Showing the first 200. Use Find to reach the rest.'));
    }
  }

  function findNext() {
    var q = find.value;
    if (!q) { msg.textContent = 'Type something to find.'; return false; }
    var hay = ta.value.toLowerCase(), n = q.toLowerCase();
    var i = hay.indexOf(n, ta.selectionEnd || 0);
    if (i === -1) i = hay.indexOf(n, 0);
    if (i === -1) { msg.textContent = 'No matches.'; return false; }
    var total = hay.split(n).length - 1;
    var idx = hay.slice(0, i).split(n).length;
    msg.textContent = 'Match ' + idx + ' of ' + total + '.';
    jumpTo(ta, i, i + q.length);
    return true;
  }

  function replaceOne() {
    var q = find.value;
    if (!q) { msg.textContent = 'Type something to find.'; return; }
    var s = ta.selectionStart, e = ta.selectionEnd;
    if (e > s && ta.value.slice(s, e).toLowerCase() === q.toLowerCase()) {
      var v = ta.value;
      var end = s + repl.value.length;
      setValue(v.slice(0, s) + repl.value + v.slice(e), end, end);
    }
    findNext();
  }

  function replaceAll() {
    var q = find.value;
    if (!q) { msg.textContent = 'Type something to find.'; return; }
    var re = new RegExp(escapeRe(q), 'gi');
    var count = (ta.value.match(re) || []).length;
    if (count === 0) { msg.textContent = 'No matches.'; return; }
    setValue(ta.value.replace(re, function () { return repl.value; }));
    msg.textContent = 'Replaced ' + count + (count === 1 ? ' match.' : ' matches.') + ' Tap Cancel if you want to throw these changes away.';
  }

  ta.addEventListener('input', function () {
    clearTimeout(timer);
    timer = setTimeout(renderMarks, 250);
  });
  $(p + '-find-next').addEventListener('click', findNext);
  $(p + '-replace').addEventListener('click', replaceOne);
  $(p + '-replace-all').addEventListener('click', replaceAll);
  find.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); findNext(); }
  });
  renderMarks();
}

function onFindShortcut(e) {
  if (!(e.ctrlKey || e.metaKey) || String(e.key).toLowerCase() !== 'f') return;
  var p = $('modal-organize').style.display === 'flex' ? 'org'
    : ($('modal-chapter').style.display === 'flex' ? 'ch' : null);
  if (!p) return;
  e.preventDefault();
  var ta = $(p === 'org' ? 'org-text' : 'ch-body');
  var picked = (ta.selectionEnd > ta.selectionStart) ? ta.value.slice(ta.selectionStart, ta.selectionEnd) : '';
  $(p + '-tools').open = true;
  var f = $(p + '-find');
  if (picked && picked.length < 80 && picked.indexOf('\n') === -1) f.value = picked;
  f.focus();
  f.select();
}

function wire() {
  setupTextTools('org', 'org-text');
  setupTextTools('ch', 'ch-body');
  document.addEventListener('keydown', onFindShortcut);
  $('form-login').addEventListener('submit', handleLogin);
  $('form-signup').addEventListener('submit', handleSignup);
  $('form-unlock').addEventListener('submit', handleUnlock);
  $('device-badge').addEventListener('click', openSettings);
  $('btn-help').addEventListener('click', openHelp);
  $('help-close').addEventListener('click', function () { $('modal-help').style.display = 'none'; });
  $('settings-save').addEventListener('click', saveSettings);
  $('settings-cancel').addEventListener('click', function () { $('modal-settings').style.display = 'none'; });
  $('btn-show-paste').addEventListener('click', function () {
    var id = $('reader-reattach').getAttribute('data-book');
    var bk = state.books.filter(function (x) { return x.id === id; })[0];
    if (bk) openAddText(bk, 'reader');
  });
  $('btn-edit-addtext').addEventListener('click', function () { if (editing) openAddText(editing.book, 'edit'); });
  setupTextTools('at', 'at-text');
  $('at-text').addEventListener('input', updateAtCount);
  $('at-file').addEventListener('change', onAtFile);
  $('at-detect-ch').addEventListener('click', function () { runDetectChapters('at-text', 'at-msg'); });
  $('at-detect-sub').addEventListener('click', function () { runDetectSub('at-text', 'at-msg'); });
  $('at-cancel').addEventListener('click', closeAddText);
  $('at-save').addEventListener('click', function () { saveAddText(false); });
  $('at-save-anyway').addEventListener('click', function () { saveAddText(true); });
  $('at-goback').addEventListener('click', function () { $('at-warn').style.display = 'none'; $('at-actions').style.display = ''; });
  $('to-signup').addEventListener('click', function (e) { e.preventDefault(); showAuthForm('signup'); });
  $('to-login').addEventListener('click', function (e) { e.preventDefault(); showAuthForm('login'); });
  $('unlock-logout').addEventListener('click', function (e) { e.preventDefault(); handleLogout(); });
  $('btn-logout').addEventListener('click', handleLogout);

  Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
    b.addEventListener('click', function () { showView(b.getAttribute('data-view')); });
  });

  $('btn-add-book').addEventListener('click', openAddModal);
  $('add-cancel').addEventListener('click', closeAddModal);
  $('add-save').addEventListener('click', saveNewBook);

  $('reader-back').addEventListener('click', function () { closeReader(false); });
  $('size-up').addEventListener('click', function () { fontSize = Math.min(34, fontSize + 2); applyFontSize(); });
  $('size-down').addEventListener('click', function () { fontSize = Math.max(14, fontSize - 2); applyFontSize(); });
  $('reader-scroll').addEventListener('scroll', onReaderScroll);
  ['touchstart', 'click', 'keydown'].forEach(function (t) {
    $('reader-scroll').addEventListener(t, function () { if (reader) reader.lastActivity = Date.now(); }, { passive: true });
  });
  $('btn-toc').addEventListener('click', openToc);
  $('toc-close').addEventListener('click', function () { $('modal-toc').style.display = 'none'; });

  $('edit-back').addEventListener('click', closeEdit);
  $('edit-save-details').addEventListener('click', saveDetails);
  $('btn-add-chapter').addEventListener('click', function () { openChapterModal(null); });
  $('btn-organize').addEventListener('click', openOrganize);
  $('ch-cancel').addEventListener('click', function () { $('modal-chapter').style.display = 'none'; });
  $('ch-save').addEventListener('click', saveChapterModal);
  $('ch-detect').addEventListener('click', function () { runDetectSub('ch-body', 'ch-msg'); });
  $('org-cancel').addEventListener('click', function () { $('modal-organize').style.display = 'none'; });
  $('org-apply').addEventListener('click', applyOrganize);
  $('org-detect-ch').addEventListener('click', function () { runDetectChapters('org-text', 'org-msg'); });
  $('org-detect-sub').addEventListener('click', function () { runDetectSub('org-text', 'org-msg'); });

  document.addEventListener('selectionchange', onSelectionChange);
  buildHlBar();
  $('hl-bar').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('reader-body').addEventListener('click', function (e) {
    if (bmMode) { placeBookmark(e.clientX, e.clientY); return; }
    var m = e.target.closest ? e.target.closest('mark.hl') : null;
    var sel = window.getSelection ? window.getSelection() : null;
    if (m && (!sel || sel.isCollapsed)) openHlPanel(m.getAttribute('data-h'), 'reader');
  });
  $('hl-add').addEventListener('click', addHlComment);
  $('hl-close').addEventListener('click', closeHlPanel);
  $('hl-delete').addEventListener('click', deleteHighlight);
  $('hl-new').addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); addHlComment(); }
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushEvents();
      if (reader) persistProgress(reader);
    }
  });
}

function loadSupabase(cb) {
  if (window.supabase) return cb();
  var tag = document.createElement('script');
  tag.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js';
  tag.onload = cb;
  tag.onerror = function () {
    showAuthForm('login');
    showMsg('login-msg', "Couldn't load DoomReader's connection library. Check your internet and refresh the page.", 'error');
  };
  document.head.appendChild(tag);
}

function init() {
  wire();
  if (SUPABASE_URL.indexOf('PASTE_') === 0 || SUPABASE_KEY.indexOf('PASTE_') === 0) {
    showAuthForm('login');
    showMsg('login-msg', 'Setup needed: add your Supabase URL and publishable key at the top of the script.', 'error');
    return;
  }
  loadSupabase(function () {
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    checkSession();
  });
}

init();
