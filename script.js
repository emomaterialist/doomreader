'use strict';

/* ============================================================
   DoomReader
   1) Paste your DoomReader project URL and publishable key below.
      (Supabase > Project Settings > API Keys. Never use the secret key here.)
   ============================================================ */
var SUPABASE_URL = 'https://asqagrzeadzmtedttfzi.supabase.co';
var SUPABASE_KEY = 'sb_publishable_5LpOZw3izDYGbB4IgwCsdg_gKy8rSYq';
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
    sessions: [],
    events: [],
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
    sb.from('feed_events').select('card_type,ref_id,event,created_at').gte('created_at', since14).limit(2000)
  ]);
  state.books = (r[0].data || []);
  state.highlights = (r[1].data || []);
  state.sessions = (r[2].data || []);
  state.events = (r[3].data || []);
  if (r[0].error || r[1].error) toast("Couldn't load everything. Check your connection.");
}

/* ============================================================
   Views
   ============================================================ */
function showView(name) {
  state.view = name;
  ['feed', 'library', 'reader'].forEach(function (v) {
    $('view-' + v).classList.toggle('active', v === name);
  });
  $('nav').style.display = (name === 'reader') ? 'none' : 'flex';
  Array.prototype.forEach.call(document.querySelectorAll('.nav-btn'), function (b) {
    b.classList.toggle('active', b.getAttribute('data-view') === name);
  });
  if (name !== 'reader') hideHlBtn();
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
    node.classList.add('c' + (palette % 4));
    node.setAttribute('data-ref', c.h.id);
    node.appendChild(el('div', 'card-kicker', 'From your highlights'));
    var q = el('p', 'quote', '“' + c.h.quote + '”');
    if (c.h.quote.length > 220) q.classList.add('long');
    node.appendChild(q);
    var meta = el('div', 'card-meta', c.book.title);
    if (c.book.author) meta.appendChild(el('small', '', c.book.author));
    node.appendChild(meta);
    if (c.h.note) node.appendChild(el('div', 'card-note', c.h.note));

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
function renderLibrary() {
  var list = $('library-list');
  list.textContent = '';
  if (state.books.length === 0) {
    list.appendChild(el('p', 'empty', 'No books yet. Tap Add book to paste text or choose a .txt file.'));
    return;
  }
  var order = { reading: 0, queued: 1, finished: 2 };
  var books = state.books.slice().sort(function (a, b) {
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
    var acts = el('div', 'book-actions');
    var read = el('button', 'btn btn-primary btn-small', b.status === 'queued' ? 'Start' : (b.status === 'finished' ? 'Read again' : 'Continue'));
    read.type = 'button';
    read.addEventListener('click', function () {
      state.returnView = 'library';
      openBook(b.id, b.status === 'finished' ? 0 : null);
    });
    var del = el('button', 'btn btn-small', 'Delete');
    del.type = 'button';
    del.addEventListener('click', function () { deleteBook(b); });
    acts.appendChild(read);
    acts.appendChild(del);
    card.appendChild(acts);
    list.appendChild(card);
  });
}

async function deleteBook(b) {
  if (!window.confirm('Delete "' + b.title + '" and its highlights? This cannot be undone.')) return;
  var res = await sb.from('books').delete().eq('id', b.id);
  if (res.error) return toast("Couldn't delete. Try again.");
  try { await idbDel(b.id); } catch (e) { /* ignore */ }
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
  if (res.error || !res.data) return showMsg('add-msg', "Couldn't save the book. Check your connection and try again.", 'error');
  try {
    await idbSet(res.data.id, text);
  } catch (e) {
    await sb.from('books').delete().eq('id', res.data.id);
    return showMsg('add-msg', "Your browser wouldn't store the text. Free up space or try another browser.", 'error');
  }
  state.books.unshift(res.data);
  state.feedDirty = true;
  closeAddModal();
  renderLibrary();
  toast('Added to your library');
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

function splitParagraphs(text) {
  var parts = text.split(/\n\s*\n/).map(function (s) { return s.replace(/\s*\n\s*/g, ' ').trim(); }).filter(Boolean);
  if (parts.length < 3 && text.length > 2000) {
    parts = text.split(/\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  }
  return parts;
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

  var text = null;
  try { text = await idbGet(id); } catch (e) { text = null; }
  if (!text) {
    $('reader-body').style.display = 'none';
    $('reader-reattach').style.display = 'block';
    $('reattach-text').value = '';
    $('reattach-file').value = '';
    clearMsg('reattach-msg');
    $('reader-reattach').setAttribute('data-book', id);
    return;
  }

  var frag = document.createDocumentFragment();
  splitParagraphs(text).forEach(function (p) { frag.appendChild(el('p', '', p)); });
  $('reader-body').appendChild(frag);

  var pct = (startPct !== null && startPct !== undefined) ? startPct : (Number(book.progress_pct) || 0);
  requestAnimationFrame(function () { setScrollPct(pct); });

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

/* ---------- highlights ---------- */
function hideHlBtn() { $('hl-btn').style.display = 'none'; }

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
  $('hl-btn').style.display = selectedReaderText() ? 'block' : 'none';
}

async function saveHighlight() {
  if (!reader) return;
  var quote = selectedReaderText();
  if (!quote) return hideHlBtn();
  if (quote.length > MAX_QUOTE_CHARS) return toast('Too long. Select ' + MAX_QUOTE_CHARS + ' characters or fewer.');
  var sel = window.getSelection();
  var pos = reader.pct;
  try {
    var rect = sel.getRangeAt(0).getBoundingClientRect();
    var sc = $('reader-scroll');
    var top = sc.scrollTop + rect.top - sc.getBoundingClientRect().top;
    var max = scrollMax();
    if (max > 0) pos = Math.round(Math.min(100, Math.max(0, top / max * 100)) * 10) / 10;
  } catch (e) { /* keep reader.pct */ }
  var res = await sb.from('highlights').insert({
    user_id: currentUser.id,
    book_id: reader.book.id,
    quote: quote,
    position_pct: pos
  }).select().single();
  if (res.error || !res.data) return toast("Couldn't save. Try again.");
  state.highlights.unshift(res.data);
  state.feedDirty = true;
  if (window.getSelection) window.getSelection().removeAllRanges();
  hideHlBtn();
  toast('Highlight saved');
}

async function saveReattach() {
  var id = $('reader-reattach').getAttribute('data-book');
  var text = await getTextFrom('reattach-file', 'reattach-text', 'reattach-msg');
  if (text === null) return;
  try { await idbSet(id, text); } catch (e) {
    return showMsg('reattach-msg', "Your browser wouldn't store the text.", 'error');
  }
  openBook(id, null);
}

/* ============================================================
   Wire up
   ============================================================ */
function wire() {
  $('form-login').addEventListener('submit', handleLogin);
  $('form-signup').addEventListener('submit', handleSignup);
  $('form-unlock').addEventListener('submit', handleUnlock);
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
  $('btn-reattach').addEventListener('click', saveReattach);

  document.addEventListener('selectionchange', onSelectionChange);
  $('hl-btn').addEventListener('mousedown', function (e) { e.preventDefault(); });
  $('hl-btn').addEventListener('click', saveHighlight);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      flushEvents();
      if (reader) persistProgress(reader);
    }
  });
}

function init() {
  wire();
  if (!window.supabase || SUPABASE_URL.indexOf('PASTE_') === 0 || SUPABASE_KEY.indexOf('PASTE_') === 0) {
    showAuthForm('login');
    showMsg('login-msg', 'Setup needed: paste your Supabase URL and publishable key at the top of script.js.', 'error');
    return;
  }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  checkSession();
}

init();
