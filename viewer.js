/*
 * Badminton Finder — the code that runs on flgloucester.gladstonego.cloud
 * when you tap the bookmarklet. It asks the booking system (the same API the
 * official site uses) for badminton sessions at Oxstalls and GL1, and shows
 * the free times in one simple list. It only reads availability.
 *
 * index.html turns this function into the bookmarklet link, so everything it
 * needs must live inside it. Use only block comments in here: line comments
 * would break the bookmarklet.
 */
window.BADMINTON_FINDER = function () {
  /* ---------- Settings ---------- */
  var VENUES = [
    /* Names are compared with spaces and punctuation removed, so
       "G L 1 Leisure Centre", "GL1" and "G.L.1" all match. */
    { key: 'oxstalls', label: 'Oxstalls', match: /oxstalls/ },
    { key: 'gl1', label: 'GL1', match: /gl1|gloucesterleisurecentre/ }
  ];
  var ACTIVITY_MATCH = /badminton/i;
  /* Some venues (e.g. GL1) put badminton inside a broader activity such as
     "Racquet Sports". Those activities are fetched too, and only the
     sessions or courts that mention badminton are kept. */
  var BROAD_MATCH = /racq|racket|court hire|sports hall/i;
  var TZ = 'Europe/London';
  var HOST = 'flgloucester.gladstonego.cloud';
  var ID = 'bf-overlay';

  if (location.hostname !== HOST) {
    if (confirm('Badminton Finder works on the Gloucester booking site.\n\nOpen it now? Then tap the bookmark again.')) {
      location.href = 'https://' + HOST + '/book';
    }
    return;
  }

  /* Running it again replaces the open list cleanly */
  var existing = document.getElementById(ID);
  if (existing) { if (existing.bfClose) existing.bfClose(); else existing.remove(); }

  /* ---------- Small helpers ---------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'on') Object.keys(attrs.on).forEach(function (e) { n.addEventListener(e, attrs.on[e]); });
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function store(k, v) {
    try {
      if (v === undefined) return JSON.parse(localStorage.getItem('bf.' + k));
      localStorage.setItem('bf.' + k, JSON.stringify(v));
    } catch (e) { return null; }
  }
  var fmtDayKey = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var fmtTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  var fmtDayLong = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
  var fmtDayShort = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric' });
  function dayKey(d) { return fmtDayKey.format(d); }

  /* Slot times come back as ISO strings. With an offset or "Z" we convert to
     UK time; without one they are already UK wall-clock time, whatever time
     zone the phone is set to. */
  function parseTime(s) {
    if (!s) return null;
    if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) {
      var d = new Date(s);
      return { date: d, day: dayKey(d), hm: fmtTime.format(d) };
    }
    var m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(s);
    if (!m) return null;
    var hm = m[4] + ':' + m[5];
    var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    /* UK is UTC+0 or UTC+1: pick the one that shows the same clock time */
    var date = fmtTime.format(new Date(utc - 36e5)) === hm ? new Date(utc - 36e5) : new Date(utc);
    return { date: date, day: m[1] + '-' + m[2] + '-' + m[3], hm: hm };
  }

  /* ---------- Talking to the booking system ---------- */
  /* The booking page uses an anonymous guest token for browsing before you
     log in; this gets the same one, the same way. */
  var token = null;
  async function getToken() {
    if (token) return token;
    var res = await fetch('/validate/tenant/anonymous', { credentials: 'include' });
    if (!res.ok) throw new Error('Could not start a session with the booking site (' + res.status + ').');
    var enc = (await res.text()).trim().replace(/^"|"$/g, '');
    var seed = location.hostname;
    while (seed.length <= 32) seed += seed;
    var keyBytes = new TextEncoder().encode(seed.slice(0, 32));
    var raw = Uint8Array.from(atob(enc), function (c) { return c.charCodeAt(0); });
    var key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
    var plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: raw.slice(0, 16) }, key, raw.slice(16));
    var obj = JSON.parse(new TextDecoder().decode(plain));
    token = obj.Token || obj.token;
    if (!token) throw new Error('The booking site sent an unexpected session token.');
    return token;
  }
  async function api(path) {
    var t = await getToken();
    var res = await fetch(path, {
      credentials: 'include',
      headers: { accept: 'application/json, text/plain, */*', authorization: 'Bearer ' + t }
    });
    if (!res.ok) throw new Error('Booking site returned ' + res.status + ' for ' + path.split('?')[0]);
    return res.json();
  }
  function asList(x) { return Array.isArray(x) ? x : (x && (x.items || x.data || x.results)) || []; }

  function squash(name) { return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /* Finds the site IDs for Oxstalls / GL1 and each one's badminton
     activity IDs. Cached for a week so later taps are quicker. */
  async function discover() {
    var cached = store('venues');
    if (cached && cached.at > Date.now() - 7 * 864e5 && cached.venues.length === VENUES.length) return cached;
    var sites = asList(await api('/api/configuration/sites?includeFacilitiesAndAmenities=true&isActive=true'));
    var venues = [], problems = [];
    for (var i = 0; i < VENUES.length; i++) {
      var v = VENUES[i];
      var hits = sites.filter(function (s) { return v.match.test(squash(s.name)); });
      if (!hits.length) problems.push(v.label + ': no venue with that name. The booking site lists: ' + sites.map(function (s) { return s.name; }).join(', ') + '.');
      for (var j = 0; j < hits.length; j++) {
        var acts = asList(await api('/api/search/activities/?webBookableOnly=true&siteIds=' + encodeURIComponent(hits[j].id)));
        var matches = acts.filter(function (a) { return ACTIVITY_MATCH.test(a.name || '') || BROAD_MATCH.test(a.name || ''); });
        if (!matches.length) problems.push(v.label + ': found "' + hits[j].name + '" but no badminton. Its activities are: ' + (acts.map(function (a) { return a.name; }).join(', ') || 'none') + '.');
        if (matches.length) venues.push({
          key: v.key, label: v.label, siteId: hits[j].id, siteName: hits[j].name,
          activities: matches.map(function (a) { return { id: a.id, name: a.name, broad: !ACTIVITY_MATCH.test(a.name || '') }; })
        });
      }
    }
    /* Merge several matching sites (e.g. two GL1 entries) into one venue */
    var merged = [];
    venues.forEach(function (v) {
      var m = merged.filter(function (x) { return x.key === v.key; })[0];
      if (m) { m.parts.push(v); } else { merged.push({ key: v.key, label: v.label, parts: [v] }); }
    });
    var result = { at: Date.now(), venues: merged, problems: problems, siteNames: sites.map(function (s) { return s.name; }) };
    /* Only cache when every venue was found, so a miss is retried next time */
    if (merged.length === VENUES.length) store('venues', result);
    return result;
  }

  /* UK date keys from today up to and including lastKey (at least today,
     at most about two months). */
  function daysUntil(lastKey) {
    var p = dayKey(new Date()).split('-').map(Number), out = [];
    for (var i = 0; i < 62; i++) {
      var k = new Date(Date.UTC(p[0], p[1] - 1, p[2] + i)).toISOString().slice(0, 10);
      if (i > 0 && (!lastKey || k > lastKey)) break;
      out.push(k);
    }
    return out;
  }

  /* Gets every free badminton court the booking site returns. It sends
     exactly ONE request per venue, starting from now, one venue at a time,
     and shows however many days that reply covers (a few weeks, in practice).
     There are no follow-up requests and no automatic retries, so the
     booking site isn't flooded. Tap the refresh button to try again. */
  async function loadSlots(venues, onProgress) {
    var now = new Date();
    var nowMin = new Date(now); nowMin.setUTCSeconds(0, 0);
    var out = {}, errors = [], failed = {}, seen = {}, hasBadminton = {}, requests = 0, lastDay = null;
    function sessionsUrl(part, from) {
      return '/api/availability/V2/sessions?webBookableOnly=true' +
        '&siteIds=' + encodeURIComponent(part.siteId) +
        '&activityIds=' + encodeURIComponent(part.activities.map(function (a) { return a.id; }).join(',')) +
        '&dateFrom=' + encodeURIComponent(from.toISOString());
    }
    /* Reads one reply; returns the latest day it covered (or null) */
    function take(v, part, rows) {
      var maxDay = null;
      rows.forEach(function (sess) {
        if (sess.date && (!maxDay || String(sess.date).slice(0, 10) > maxDay)) maxDay = String(sess.date).slice(0, 10);
        var actId = sess.activityId || sess.activityID;
        var act = actId == null ? null : part.activities.filter(function (a) { return String(a.id) === String(actId); })[0];
        /* If the session doesn't say which activity it is, only trust it as
           badminton when none of the activities asked for are broad ones */
        var broad = act ? act.broad : part.activities.some(function (a) { return a.broad; });
        var sessText = [sess.name, sess.activityName, sess.displayName].join(' ');
        (sess.locations || []).forEach(function (loc) {
          var court = (loc.locationNameToDisplay || loc.locationName || loc.name || 'Court').trim();
          var badminton = !broad || ACTIVITY_MATCH.test(sessText + ' ' + court);
          (loc.slots || []).forEach(function (s) {
            var st = parseTime(s.startTime), en = parseTime(s.endTime);
            if (!st) return;
            if (!maxDay || st.day > maxDay) maxDay = st.day;
            if (st.date < now) return;
            if (!badminton) {
              (seen[v.key] = seen[v.key] || {})[(sess.name || '?') + ' / ' + court] = true;
              return;
            }
            hasBadminton[v.key] = true;
            var avail = s.availability && typeof s.availability.inCentre === 'number' ? s.availability.inCentre : 1;
            if (String(s.status).toLowerCase() !== 'available' || avail <= 0) return;
            var k = [v.key, st.day, st.hm, en ? en.hm : '', sess.name || ''].join('|');
            var item = out[k] || (out[k] = {
              venue: v, day: st.day, start: st.hm, end: en ? en.hm : '', sort: st.date.getTime(),
              activity: sess.name || '', activityId: act ? act.id : (actId || part.activities[0].id), courts: {}, opens: null
            });
            item.courts[court] = true;
            if (s.bookableFrom) {
              var bf = new Date(s.bookableFrom);
              if (bf > now) item.opens = bf;
            }
          });
        });
      });
      return maxDay;
    }
    async function loadPart(v, part) {
      try {
        requests++;
        var maxDay = take(v, part, asList(await api(sessionsUrl(part, nowMin))));
        if (maxDay && (!lastDay || maxDay > lastDay)) lastDay = maxDay;
      } catch (e) {
        errors.push(e.message);
        failed[v.label] = true;
      }
    }
    /* One venue at a time, to be gentle on the booking site */
    for (var vi = 0; vi < venues.length; vi++) {
      onProgress(venues[vi].label);
      for (var pi = 0; pi < venues[vi].parts.length; pi++) await loadPart(venues[vi], venues[vi].parts[pi]);
    }
    var list = Object.keys(out).map(function (k) { var x = out[k]; x.courts = Object.keys(x.courts).sort(); return x; });
    list.sort(function (a, b) { return a.sort - b.sort || a.venue.label.localeCompare(b.venue.label); });
    /* A venue that only has a broad activity and nothing named badminton
       gets a note listing what it does have, to help fix the matching. */
    var notes = venues.filter(function (v) { return !hasBadminton[v.key] && seen[v.key]; }).map(function (v) {
      return v.label + ': no sessions mentioning badminton under ' +
        v.parts.map(function (p) { return p.activities.map(function (a) { return '"' + a.name + '"'; }).join(', '); }).join(', ') +
        '. Sessions seen: ' + Object.keys(seen[v.key]).slice(0, 15).join('; ') + '.';
    });
    return { slots: list, errors: errors, failed: failed, notes: notes, lastDay: lastDay, failedAll: errors.length > 0 && errors.length === requests };
  }

  /* ---------- UI ---------- */
  var css = [
    '#ID{--bg:#f6f7f5;--card:#fff;--ink:#17201b;--muted:#5d6b63;--line:#dfe4e0;--accent:#1f7a4d;--accent-ink:#fff;--ox:#1f7a4d;--gl:#2a5fa8;--warn:#9a5b00;',
    'position:fixed;inset:0;z-index:2147483647;background:var(--bg);color:var(--ink);overflow:auto;-webkit-overflow-scrolling:touch;',
    'font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;text-align:left}',
    '@media (prefers-color-scheme:dark){#ID{--bg:#111513;--card:#1a201d;--ink:#e8eee9;--muted:#9aa8a0;--line:#2b3430;--accent:#3fb37a;--accent-ink:#06130c;--ox:#3fb37a;--gl:#6f9fe6;--warn:#e2a54a}}',
    '#ID *{box-sizing:border-box;font-family:inherit}',
    '#ID .wrap{max-width:720px;margin:0 auto;padding:16px 16px 48px}',
    '#ID header{display:flex;align-items:center;gap:12px;margin-bottom:12px}',
    '#ID h1{font-size:22px;margin:0;flex:1;font-weight:700;letter-spacing:-.01em}',
    '#ID button{font:inherit;cursor:pointer;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);padding:8px 14px;min-height:40px}',
    '#ID button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}',
    '#ID .x{font-size:20px;width:40px;padding:0}',
    '#ID .bar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 10px}',
    '#ID .days{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:6px;scrollbar-width:none}',
    '#ID .days button{flex:0 0 auto;border-radius:12px;display:flex;flex-direction:column;align-items:center;min-width:64px;padding:6px 10px}',
    '#ID .days small{font-size:12px;opacity:.8}',
    '#ID h2{font-size:15px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:22px 0 8px;font-weight:600}',
    '#ID .slot{display:flex;align-items:center;gap:12px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 14px;margin-bottom:8px;text-decoration:none;color:inherit}',
    '#ID .slot:hover{border-color:var(--accent)}',
    '#ID .time{font-weight:700;font-size:18px;min-width:108px;font-variant-numeric:tabular-nums}',
    '#ID .meta{flex:1;min-width:0;color:var(--muted);font-size:14px}',
    '#ID .tag{display:inline-block;font-size:13px;font-weight:600;padding:2px 8px;border-radius:999px;color:#fff;margin-right:6px}',
    '#ID .tag.oxstalls{background:var(--ox)}#ID .tag.gl1{background:var(--gl)}',
    '@media (prefers-color-scheme:dark){#ID .tag{color:#08110c}}',
    '#ID .go{font-weight:600;color:var(--accent);white-space:nowrap}',
    '#ID .opens{color:var(--warn)}',
    '#ID .note{color:var(--muted);font-size:14px;margin:8px 0}',
    '#ID .err{background:var(--card);border:1px solid var(--warn);border-radius:12px;padding:12px 14px;margin:12px 0}',
    '#ID .empty{text-align:center;color:var(--muted);padding:40px 0}',
    '@media (max-width:480px){#ID .time{min-width:auto;font-size:17px;flex:1}#ID .slot{flex-wrap:wrap;gap:4px 10px}#ID .meta{flex-basis:100%;order:3}}'
  ].join('\n').replace(/#ID/g, '#' + ID);

  var state = {
    venue: store('venue') || 'all',
    when: store('when') || 'all',
    day: 'all',
    data: null
  };
  var root = el('div', { id: ID, role: 'dialog', 'aria-label': 'Badminton Finder' });
  root.appendChild(el('style', { text: css }));
  var wrap = el('div', { class: 'wrap' });
  root.appendChild(wrap);
  document.body.appendChild(root);
  var prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';
  function close() { root.remove(); document.documentElement.style.overflow = prevOverflow; document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  root.bfClose = close;

  function header(sub) {
    return el('header', null, [
      el('h1', { text: '🏸 Badminton Finder' }),
      sub || null,
      el('button', { class: 'x', title: 'Close', 'aria-label': 'Close', text: '×', on: { click: close } })
    ]);
  }
  function toggle(label, pressed, onClick) {
    return el('button', { 'aria-pressed': String(pressed), text: label, on: { click: onClick } });
  }

  function render() {
    wrap.textContent = '';
    var d = state.data;
    wrap.appendChild(header(el('button', { text: '↻', title: 'Refresh', 'aria-label': 'Refresh', class: 'x', on: { click: function () { start(); } } })));

    var vbar = el('div', { class: 'bar' });
    [['all', 'Both venues']].concat(d.venues.map(function (v) { return [v.key, v.label]; }))
      .filter(function (x, i, arr) { return arr.findIndex(function (y) { return y[0] === x[0]; }) === i; })
      .forEach(function (x) {
        vbar.appendChild(toggle(x[1], state.venue === x[0], function () { state.venue = x[0]; store('venue', x[0]); render(); }));
      });
    wrap.appendChild(vbar);

    var wbar = el('div', { class: 'bar' });
    [['all', 'Any time'], ['day', 'Daytime'], ['eve', 'After 5pm'], ['wkd', 'Weekends']].forEach(function (x) {
      wbar.appendChild(toggle(x[1], state.when === x[0], function () { state.when = x[0]; store('when', x[0]); render(); }));
    });
    wrap.appendChild(wbar);

    var slots = d.slots.filter(function (s) {
      if (state.venue !== 'all' && s.venue.key !== state.venue) return false;
      var h = parseInt(s.start, 10);
      var wd = new Date(s.day + 'T12:00:00Z').getUTCDay();
      if (state.when === 'eve' && h < 17) return false;
      if (state.when === 'day' && h >= 17) return false;
      if (state.when === 'wkd' && wd !== 0 && wd !== 6) return false;
      return true;
    });

    var days = daysUntil(d.lastDay);
    var dbar = el('div', { class: 'days' });
    dbar.appendChild(el('button', { 'aria-pressed': String(state.day === 'all'), on: { click: function () { state.day = 'all'; render(); } } },
      [el('span', { text: 'All' }), el('small', { text: slots.length + ' free' })]));
    days.forEach(function (k, i) {
      var n = slots.filter(function (s) { return s.day === k; }).length;
      var label = i === 0 ? 'Today' : i === 1 ? 'Tmrw' : fmtDayShort.format(new Date(k + 'T12:00:00Z'));
      dbar.appendChild(el('button', { 'aria-pressed': String(state.day === k), on: { click: function () { state.day = k; render(); } } },
        [el('span', { text: label }), el('small', { text: n ? n + ' free' : '—' })]));
    });
    wrap.appendChild(dbar);

    if (d.warning) wrap.appendChild(el('div', { class: 'err', text: d.warning }));
    if (d.failedAll) {
      wrap.appendChild(el('div', { class: 'err', text: 'Couldn\u2019t load availability: ' + d.errors[0] }));
    } else if (d.errors.length) {
      wrap.appendChild(el('div', { class: 'err', text: 'Couldn\u2019t load ' + Object.keys(d.failed).join(' or ') +
        ' (' + d.errors[0] + '), so it\u2019s missing from the list. Tap \u21bb to try again.' }));
    }

    var shown = slots.filter(function (s) { return state.day === 'all' || s.day === state.day; });
    if (!shown.length) {
      wrap.appendChild(el('div', { class: 'empty', text: 'No free badminton courts for these filters.' }));
    }
    var lastDay = null;
    shown.forEach(function (s) {
      if (s.day !== lastDay) {
        lastDay = s.day;
        wrap.appendChild(el('h2', { text: fmtDayLong.format(new Date(s.day + 'T12:00:00Z')) }));
      }
      /* Open the calendar at the whole hour before the slot (17:15 -> 16:00,
         15:00 -> 14:00), so the slot shows just below the top. UK time is
         a whole number of hours from UTC, so rounding in UTC is safe. */
      var openAt = Math.floor(s.sort / 36e5) * 36e5 - 36e5;
      var href = '/book/calendar/' + encodeURIComponent(s.activityId) + '?activityDate=' + new Date(openAt).toISOString();
      var courts = s.courts.length + (s.courts.length === 1 ? ' court free' : ' courts free');
      var meta = [el('span', { class: 'tag ' + s.venue.key, text: s.venue.label }), courts];
      if (s.activity && d.multiActivity) meta.push(' · ' + s.activity);
      if (s.opens) meta.push(el('span', { class: 'opens', text: ' · opens ' + fmtDayShort.format(s.opens) + ' ' + fmtTime.format(s.opens) }));
      wrap.appendChild(el('a', { class: 'slot', href: href, title: s.courts.join(', ') }, [
        el('span', { class: 'time', text: s.start + (s.end ? '–' + s.end : '') }),
        el('span', { class: 'meta' }, meta),
        el('span', { class: 'go', text: 'Book ›' })
      ]));
    });
    wrap.appendChild(el('p', { class: 'note', text: 'Tap a time to open it in the normal booking page. Updated ' + fmtTime.format(d.at) + '.' }));
  }

  function message(text, isErr) {
    wrap.textContent = '';
    wrap.appendChild(header());
    wrap.appendChild(el('div', { class: isErr ? 'err' : 'note', text: text }));
  }

  async function start() {
    try {
      message('Finding badminton at Oxstalls and GL1…');
      var ids = await discover();
      var found = ids.venues.map(function (v) { return v.key; });
      var missing = VENUES.filter(function (v) { return found.indexOf(v.key) < 0; }).map(function (v) { return v.label; });
      if (!ids.venues.length) {
        message('Couldn\u2019t find badminton at Oxstalls or GL1. ' + ((ids.problems || []).join(' ') || 'The booking site lists no venues.'), true);
        return;
      }
      var res = await loadSlots(ids.venues, function (label) {
        message('Checking ' + label + '\u2026');
      });
      var actNames = {};
      res.slots.forEach(function (s) { actNames[s.activity] = 1; });
      state.data = {
        venues: ids.venues, slots: res.slots, errors: res.errors, failed: res.failed, failedAll: res.failedAll, lastDay: res.lastDay,
        multiActivity: Object.keys(actNames).length > 1, at: new Date()
      };
      if (missing.length) state.data.warning = 'Badminton wasn\u2019t found at ' + missing.join(' or ') + ', so only ' +
        ids.venues.map(function (v) { return v.label; }).join(' and ') + ' is shown. ' + (ids.problems || []).join(' ');
      if (res.notes.length) state.data.warning = ((state.data.warning || '') + ' ' + res.notes.join(' ')).trim();
      render();
    } catch (e) {
      message('Something went wrong: ' + e.message + ' — try reloading the booking page and tapping the bookmark again.', true);
    }
  }
  start();
};
