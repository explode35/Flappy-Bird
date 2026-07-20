/*
 * engine.js — pure logic for the weekly SMS check-in sequence.
 *
 * The sequence, per client, per week (on their check-in day):
 *   1. request      — check-in questions sent at config.sendHour
 *   2. reminder     — one nudge if no reply after config.reminderAfterHours
 *   3. reply        — inbound SMS parsed into a structured check-in record
 *   4. confirmation — auto-reply summarising what was logged
 *
 * No I/O here: the server calls plan() on a timer and executes the actions.
 */
'use strict';

var DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

function dateKey(d) {
  var p = function (n) { return String(n).padStart(2, '0'); };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

// ---------- phone matching ----------
function digits(p) { return String(p || '').replace(/\D+/g, ''); }

function phonesMatch(a, b) {
  var da = digits(a), db = digits(b);
  if (!da || !db) return false;
  var ta = da.slice(-10), tb = db.slice(-10);
  return ta.length >= 7 && ta === tb;
}

function findClientByPhone(clients, phone) {
  for (var i = 0; i < (clients || []).length; i++) {
    if (clients[i].phone && phonesMatch(clients[i].phone, phone)) return clients[i];
  }
  return null;
}

// ---------- scheduling ----------
/**
 * Decide what to send right now. Returns [{type:'request'|'reminder', clientId, sequenceId?}].
 * Idempotent: a client gets at most one request per check-in day and one reminder
 * per sequence, tracked via state.smsSequences.
 */
function plan(state, config, now) {
  var actions = [];
  var seqs = state.smsSequences || [];
  var clients = state.clients || [];
  var today = dateKey(now);
  var dayName = DAY_NAMES[now.getDay()];

  clients.forEach(function (c) {
    if (c.status !== 'active' || !c.phone) return;
    if (c.checkinDay !== dayName) return;
    if (now.getHours() < config.sendHour) return;
    var already = seqs.some(function (q) { return q.clientId === c.id && q.date === today; });
    if (!already) actions.push({ type: 'request', clientId: c.id });
  });

  seqs.forEach(function (q) {
    if (q.repliedAt || q.reminderSentAt) return;
    var c = null;
    for (var i = 0; i < clients.length; i++) if (clients[i].id === q.clientId) { c = clients[i]; break; }
    if (!c || c.status !== 'active' || !c.phone) return;
    var hours = (now.getTime() - Date.parse(q.requestSentAt)) / 3600000;
    if (hours >= config.reminderAfterHours && hours <= 48) {
      actions.push({ type: 'reminder', clientId: c.id, sequenceId: q.id });
    }
  });

  return actions;
}

// ---------- reply parsing ----------
function firstNum(s) {
  var m = String(s).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}
function allNums(s) {
  return (String(s).match(/-?\d+(?:\.\d+)?/g) || []).map(parseFloat);
}

/**
 * Parse a client's SMS reply into { weight, sessions, sleep, stress, adherence, notes }.
 * Understands, in order of preference:
 *   - numbered answers matching the request template ("1. 72.5" ... "5. win/struggle")
 *   - labeled values ("weight 72.5, slept 7, stress 2")
 *   - a bare run of numbers in template order ("72.5 4 7 2 4")
 */
function parseReply(body) {
  var out = { weight: null, sessions: null, sleep: null, stress: null, adherence: null, notes: '' };
  var text = String(body || '').trim();
  if (!text) return out;

  var map = {};
  var anyNumbered = false;
  text.split(/\n+/).forEach(function (line) {
    var m = line.match(/^\s*([1-5])\s*[.):\-]\s*(.+)$/);
    if (m) { map[parseInt(m[1], 10)] = m[2].trim(); anyNumbered = true; }
  });
  if (anyNumbered) {
    if (map[1] != null) out.weight = firstNum(map[1]);
    if (map[2] != null) out.sessions = firstNum(map[2]);
    if (map[3] != null) {
      var ns = allNums(map[3]);
      if (ns.length > 0) out.sleep = ns[0];
      if (ns.length > 1) out.stress = ns[1];
    }
    if (map[4] != null) out.adherence = firstNum(map[4]);
    if (map[5] != null) out.notes = map[5];
  }

  var labeled = function (re) {
    var m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  };
  if (out.weight == null) out.weight = labeled(/(?:weight|wt)[:\s]*(\d+(?:\.\d+)?)/i);
  if (out.sessions == null) out.sessions = labeled(/(?:sessions?|workouts?|trained)[:\s]*(\d+)/i);
  if (out.sleep == null) out.sleep = labeled(/(?:sleep|slept)[:\s]*(\d+(?:\.\d+)?)/i);
  if (out.stress == null) out.stress = labeled(/stress[:\s]*(\d+(?:\.\d+)?)/i);
  if (out.adherence == null) out.adherence = labeled(/(?:nutrition|adherence|diet)[:\s]*(\d+(?:\.\d+)?)/i);

  if (!anyNumbered && out.weight == null && out.sessions == null) {
    var ns2 = allNums(text);
    if (ns2.length >= 2) {
      out.weight = ns2[0];
      out.sessions = ns2[1];
      if (ns2.length > 2) out.sleep = ns2[2];
      if (ns2.length > 3) out.stress = ns2[3];
      if (ns2.length > 4) out.adherence = ns2[4];
    }
  }

  if (!out.notes && !anyNumbered && /[a-z]{4,}/i.test(text)) out.notes = text;
  if (out.sessions != null) out.sessions = Math.round(out.sessions);
  return out;
}

// ---------- message templates (SMS-length) ----------
function firstName(client) {
  return client && client.name ? client.name.split(/\s+/)[0] : 'there';
}

function buildRequest(client, coachName) {
  return 'Hey ' + firstName(client) + '! Weekly check-in from ' + (coachName || 'your coach') +
    '. Reply with:\n' +
    '1. Morning weight\n' +
    '2. Sessions done this week\n' +
    '3. Sleep hrs + stress (1-5)\n' +
    '4. Nutrition (1-5)\n' +
    '5. Biggest win + struggle\n' +
    'Short answers are perfect.';
}

function buildReminder(client) {
  return 'Quick nudge, ' + firstName(client) +
    ' — still need your check-in when you get a sec. Even two lines helps me adjust next week’s plan.';
}

function buildConfirmation(parsed, client) {
  var logged = [];
  if (parsed.weight != null) logged.push('weight ' + parsed.weight);
  if (parsed.sessions != null) logged.push(parsed.sessions + ' sessions');
  if (parsed.sleep != null) logged.push('sleep ' + parsed.sleep + 'h');
  if (parsed.stress != null) logged.push('stress ' + parsed.stress);
  if (parsed.adherence != null) logged.push('nutrition ' + parsed.adherence);
  var head = 'Got it, ' + firstName(client) + '!';
  var body = logged.length ? ' Logged: ' + logged.join(', ') + '.' : ' Check-in received.';
  return head + body + ' I’ll review tonight and tweak next week’s plan.';
}

// ---------- state helpers ----------
function blankState() {
  return { clients: [], programs: [], assignments: [], sessions: [], checkins: [], smsSequences: [], smsLog: [] };
}

/**
 * Merge a state PUT from the web UI with the server's copy. The UI owns
 * clients/programs/assignments/sessions/checkins; the server owns
 * smsSequences/smsLog. Server-created SMS check-ins the UI copy doesn't have
 * yet are kept so a stale browser tab can't drop them.
 */
function mergeState(serverState, clientData) {
  var merged = blankState();
  ['clients', 'programs', 'assignments', 'sessions', 'checkins'].forEach(function (k) {
    if (Array.isArray(clientData[k])) merged[k] = clientData[k];
  });
  merged.smsSequences = serverState.smsSequences || [];
  merged.smsLog = serverState.smsLog || [];

  var have = {};
  merged.checkins.forEach(function (c) { have[c.id] = true; });
  (serverState.checkins || []).forEach(function (c) {
    if (c.source === 'sms' && !have[c.id]) merged.checkins.push(c);
  });
  return merged;
}

module.exports = {
  DAY_NAMES: DAY_NAMES,
  uid: uid,
  dateKey: dateKey,
  phonesMatch: phonesMatch,
  findClientByPhone: findClientByPhone,
  plan: plan,
  parseReply: parseReply,
  buildRequest: buildRequest,
  buildReminder: buildReminder,
  buildConfirmation: buildConfirmation,
  blankState: blankState,
  mergeState: mergeState
};
