/*
 * server.js — Fitness Operations Engine SMS service.
 *
 * Node built-ins only. Run with:  node sms/server.js
 *
 * What it does:
 *   - Serves the web app (open http://localhost:3000) and persists its data
 *     server-side (sms/data/state.json), so the UI and the SMS engine share
 *     one store.
 *   - Every minute, runs the weekly check-in sequence: sends each active
 *     client with a phone number their check-in request on their check-in
 *     day, and one reminder if they haven't replied.
 *   - Receives Twilio inbound-SMS webhooks at POST /webhooks/sms, parses the
 *     reply into a check-in record, and answers with a confirmation.
 *   - Without Twilio credentials it runs in DRY-RUN mode: messages are
 *     logged (console + smsLog) instead of sent, so the whole flow is
 *     testable locally.
 *
 * Config: sms/config.json (see config.example.json), overridable via env:
 *   PORT, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER,
 *   FITOPS_SEND_HOUR, FITOPS_REMINDER_HOURS, FITOPS_COACH_NAME,
 *   FITOPS_PUBLIC_URL (enables Twilio signature validation),
 *   FITOPS_DATA_FILE.
 */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var querystring = require('querystring');
var engine = require('./engine');

var ROOT = path.join(__dirname, '..');

// ---------- config ----------
var config = {
  port: 3000,
  accountSid: '',
  authToken: '',
  fromNumber: '',
  sendHour: 8,            // local server hour to send the weekly request
  reminderAfterHours: 6,  // nudge after this many hours without a reply
  coachName: 'Your Coaching',
  publicUrl: '',          // e.g. https://coach.example.com — enables webhook signature checks
  dataFile: path.join(__dirname, 'data', 'state.json')
};
try {
  var fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
  Object.keys(config).forEach(function (k) { if (fileCfg[k] != null) config[k] = fileCfg[k]; });
} catch (e) { /* no config file — env/defaults only */ }
if (process.env.PORT) config.port = parseInt(process.env.PORT, 10);
if (process.env.TWILIO_ACCOUNT_SID) config.accountSid = process.env.TWILIO_ACCOUNT_SID;
if (process.env.TWILIO_AUTH_TOKEN) config.authToken = process.env.TWILIO_AUTH_TOKEN;
if (process.env.TWILIO_FROM_NUMBER) config.fromNumber = process.env.TWILIO_FROM_NUMBER;
if (process.env.FITOPS_SEND_HOUR != null) config.sendHour = parseInt(process.env.FITOPS_SEND_HOUR, 10);
if (process.env.FITOPS_REMINDER_HOURS != null) config.reminderAfterHours = parseFloat(process.env.FITOPS_REMINDER_HOURS);
if (process.env.FITOPS_COACH_NAME) config.coachName = process.env.FITOPS_COACH_NAME;
if (process.env.FITOPS_PUBLIC_URL) config.publicUrl = process.env.FITOPS_PUBLIC_URL;
if (process.env.FITOPS_DATA_FILE) config.dataFile = process.env.FITOPS_DATA_FILE;

var dryRun = !(config.accountSid && config.authToken && config.fromNumber);

// ---------- state ----------
var state = engine.blankState();
var rev = 1;
try {
  var saved = JSON.parse(fs.readFileSync(config.dataFile, 'utf8'));
  var data = saved && saved.data ? saved.data : saved;
  var base = engine.blankState();
  Object.keys(base).forEach(function (k) { if (Array.isArray(data[k])) base[k] = data[k]; });
  state = base;
  rev = (saved && saved.rev) || 1;
} catch (e) { /* fresh start */ }

function persist() {
  fs.mkdirSync(path.dirname(config.dataFile), { recursive: true });
  fs.writeFileSync(config.dataFile, JSON.stringify({ rev: rev, data: state }, null, 2));
}

function logSMS(entry) {
  entry.id = engine.uid('sm');
  entry.at = new Date().toISOString();
  state.smsLog.push(entry);
  if (state.smsLog.length > 500) state.smsLog = state.smsLog.slice(-500);
  console.log('[sms]', entry.direction, entry.kind, entry.direction === 'out' ? entry.to : entry.from,
    '(' + entry.status + ')', JSON.stringify(String(entry.body).slice(0, 60)));
}

// ---------- Twilio ----------
function sendSMS(to, body, clientId, kind) {
  if (dryRun) {
    logSMS({ direction: 'out', to: to, from: '(dry-run)', clientId: clientId, kind: kind, body: body, status: 'dry-run' });
    return Promise.resolve(true);
  }
  var url = 'https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(config.accountSid) + '/Messages.json';
  var auth = Buffer.from(config.accountSid + ':' + config.authToken).toString('base64');
  var form = new URLSearchParams({ To: to, From: config.fromNumber, Body: body }).toString();
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form
  }).then(function (res) {
    var ok = res.status >= 200 && res.status < 300;
    logSMS({ direction: 'out', to: to, from: config.fromNumber, clientId: clientId, kind: kind, body: body,
             status: ok ? 'sent' : 'failed (HTTP ' + res.status + ')' });
    return ok;
  }).catch(function (err) {
    logSMS({ direction: 'out', to: to, from: config.fromNumber, clientId: clientId, kind: kind, body: body,
             status: 'failed (' + err.message + ')' });
    return false;
  });
}

function validTwilioSignature(req, params) {
  if (!config.publicUrl) return true; // no public URL configured — can't validate, allow
  var sig = req.headers['x-twilio-signature'];
  if (!sig) return false;
  var url = config.publicUrl.replace(/\/+$/, '') + req.url;
  var data = url + Object.keys(params).sort().map(function (k) { return k + params[k]; }).join('');
  var expected = crypto.createHmac('sha1', config.authToken).update(Buffer.from(data, 'utf8')).digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch (e) { return false; }
}

// ---------- the weekly sequence ----------
function tick(now) {
  now = now || new Date();
  var actions = engine.plan(state, config, now);
  var chain = Promise.resolve();
  actions.forEach(function (a) {
    var client = null;
    state.clients.forEach(function (c) { if (c.id === a.clientId) client = c; });
    if (!client) return;
    if (a.type === 'request') {
      state.smsSequences.push({
        id: engine.uid('sq'), clientId: client.id, date: engine.dateKey(now),
        requestSentAt: now.toISOString(), reminderSentAt: null, repliedAt: null, checkinId: null
      });
      chain = chain.then(function () {
        return sendSMS(client.phone, engine.buildRequest(client, config.coachName), client.id, 'request');
      });
    } else if (a.type === 'reminder') {
      state.smsSequences.forEach(function (q) {
        if (q.id === a.sequenceId) q.reminderSentAt = now.toISOString();
      });
      chain = chain.then(function () {
        return sendSMS(client.phone, engine.buildReminder(client), client.id, 'reminder');
      });
    }
  });
  return chain.then(function () {
    if (actions.length) { rev++; persist(); }
    return actions;
  });
}

// ---------- inbound webhook ----------
function handleInbound(req, params, respond) {
  if (!validTwilioSignature(req, params)) {
    respond(403, 'text/plain', 'invalid signature');
    return;
  }
  var from = params.From || '';
  var body = params.Body || '';
  var client = engine.findClientByPhone(state.clients, from);

  if (!client) {
    logSMS({ direction: 'in', from: from, to: config.fromNumber, clientId: null, kind: 'unknown', body: body, status: 'no matching client' });
    rev++; persist();
    respond(200, 'text/xml', '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    return;
  }

  // TCPA opt-out / opt-in. Carriers also enforce STOP at the network level;
  // we mirror it so the app stops scheduling and flagging opted-out clients.
  if (engine.isOptOut(body)) {
    client.smsConsent = false;
    state.smsSequences.forEach(function (q) {
      if (q.clientId === client.id && !q.repliedAt) q.repliedAt = new Date().toISOString();
    });
    logSMS({ direction: 'in', from: from, to: config.fromNumber, clientId: client.id, kind: 'opt-out', body: body, status: 'unsubscribed' });
    rev++; persist();
    respond(200, 'text/xml', '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    return;
  }
  if (engine.isOptIn(body)) {
    client.smsConsent = true;
    logSMS({ direction: 'in', from: from, to: config.fromNumber, clientId: client.id, kind: 'opt-in', body: body, status: 'resubscribed' });
    rev++; persist();
    respond(200, 'text/xml', '<?xml version="1.0" encoding="UTF-8"?><Response/>');
    return;
  }

  var parsed = engine.parseReply(body);
  var checkin = {
    id: engine.uid('ch'), clientId: client.id, date: engine.dateKey(new Date()),
    weight: parsed.weight, sessions: parsed.sessions, sleep: parsed.sleep,
    stress: parsed.stress, adherence: parsed.adherence,
    notes: parsed.notes || '', source: 'sms'
  };
  state.checkins.push(checkin);

  var open = state.smsSequences.filter(function (q) { return q.clientId === client.id && !q.repliedAt; });
  if (open.length) {
    var seq = open[open.length - 1];
    seq.repliedAt = new Date().toISOString();
    seq.checkinId = checkin.id;
  }

  logSMS({ direction: 'in', from: from, to: config.fromNumber, clientId: client.id, kind: 'reply', body: body, status: 'parsed' });
  var confirmation = engine.buildConfirmation(parsed, client);
  logSMS({ direction: 'out', to: from, from: config.fromNumber, clientId: client.id, kind: 'confirmation', body: confirmation, status: 'twiml' });
  rev++; persist();

  var xml = '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' +
    confirmation.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') +
    '</Message></Response>';
  respond(200, 'text/xml', xml);
}

// ---------- HTTP ----------
var MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml'
};

function serveStatic(reqPath, respond) {
  var clean = path.normalize(reqPath).replace(/^([.][.][/\\])+/, '');
  if (clean === '/' || clean === '\\') clean = '/index.html';
  var full = path.join(ROOT, clean);
  // Never serve the sms/ directory (config + data live there) or dotfiles.
  if (full.indexOf(ROOT) !== 0 ||
      full.indexOf(path.join(ROOT, 'sms')) === 0 ||
      path.basename(full).charAt(0) === '.') {
    respond(404, 'text/plain', 'not found');
    return;
  }
  fs.readFile(full, function (err, buf) {
    if (err) { respond(404, 'text/plain', 'not found'); return; }
    respond(200, MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', buf);
  });
}

function readBody(req, cb) {
  var chunks = [];
  var size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > 8 * 1024 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () { cb(Buffer.concat(chunks).toString('utf8')); });
}

var server = http.createServer(function (req, res) {
  function respond(status, type, body) {
    res.writeHead(status, { 'Content-Type': type });
    res.end(body);
  }
  var urlPath = req.url.split('?')[0];

  if (urlPath === '/api/state' && req.method === 'GET') {
    respond(200, 'application/json', JSON.stringify({ rev: rev, data: state }));
    return;
  }
  if (urlPath === '/api/state' && req.method === 'PUT') {
    readBody(req, function (raw) {
      try {
        var payload = JSON.parse(raw);
        state = engine.mergeState(state, (payload && payload.data) || {});
        rev++;
        persist();
        respond(200, 'application/json', JSON.stringify({ rev: rev, data: state }));
      } catch (e) {
        respond(400, 'application/json', JSON.stringify({ error: 'invalid JSON' }));
      }
    });
    return;
  }
  if (urlPath === '/api/sms/status' && req.method === 'GET') {
    respond(200, 'application/json', JSON.stringify({
      dryRun: dryRun,
      fromNumber: config.fromNumber ? '…' + config.fromNumber.slice(-4) : null,
      sendHour: config.sendHour,
      reminderAfterHours: config.reminderAfterHours,
      serverTime: new Date().toISOString()
    }));
    return;
  }
  if (urlPath === '/api/sms/run-now' && req.method === 'POST') {
    tick().then(function (actions) {
      respond(200, 'application/json', JSON.stringify({ actions: actions }));
    });
    return;
  }
  if (urlPath === '/webhooks/sms' && req.method === 'POST') {
    readBody(req, function (raw) {
      handleInbound(req, querystring.parse(raw), respond);
    });
    return;
  }

  // ---- client portal (token-scoped, no auth cookie needed) ----
  if (urlPath === '/api/portal' && req.method === 'GET') {
    var token = new URLSearchParams(req.url.split('?')[1] || '').get('t');
    var view = engine.portalView(state, token, config.coachName);
    if (!view) { respond(404, 'application/json', JSON.stringify({ error: 'not found' })); return; }
    respond(200, 'application/json', JSON.stringify(view));
    return;
  }
  if (urlPath === '/api/portal/checkin' && req.method === 'POST') {
    var ptoken = new URLSearchParams(req.url.split('?')[1] || '').get('t');
    var pclient = engine.findClientByToken(state.clients, ptoken);
    if (!pclient || pclient.status !== 'active') {
      respond(404, 'application/json', JSON.stringify({ error: 'not found' }));
      return;
    }
    readBody(req, function (raw) {
      var b = {};
      try { b = JSON.parse(raw) || {}; } catch (e) {}
      var num = function (x) { return x != null && x !== '' && !isNaN(parseFloat(x)) ? parseFloat(x) : null; };
      var checkin = {
        id: engine.uid('ch'), clientId: pclient.id, date: engine.dateKey(new Date()),
        weight: num(b.weight), sessions: b.sessions != null ? Math.round(num(b.sessions)) : null,
        sleep: num(b.sleep), stress: num(b.stress), adherence: num(b.adherence),
        notes: typeof b.notes === 'string' ? b.notes.slice(0, 2000) : '', source: 'portal'
      };
      state.checkins.push(checkin);
      // Close any open SMS sequence so we don't nag a client who checked in via the portal.
      var open = state.smsSequences.filter(function (q) { return q.clientId === pclient.id && !q.repliedAt; });
      if (open.length) {
        var seq = open[open.length - 1];
        seq.repliedAt = new Date().toISOString();
        seq.checkinId = checkin.id;
      }
      logSMS({ direction: 'in', from: '(portal)', to: '', clientId: pclient.id, kind: 'portal-checkin',
               body: 'weight ' + (checkin.weight != null ? checkin.weight : '—'), status: 'parsed' });
      rev++; persist();
      respond(200, 'application/json', JSON.stringify({ ok: true }));
    });
    return;
  }
  // Pretty portal links: /p/<token> serves the portal shell.
  if (/^\/p\/[A-Za-z0-9]+\/?$/.test(urlPath) && req.method === 'GET') {
    serveStatic('/portal.html', respond);
    return;
  }

  if (req.method === 'GET') {
    serveStatic(urlPath, respond);
    return;
  }
  respond(405, 'text/plain', 'method not allowed');
});

server.listen(config.port, function () {
  console.log('Fitness Ops SMS engine on http://localhost:' + config.port +
    (dryRun ? '  [DRY-RUN: no Twilio credentials — messages are logged, not sent]' : ''));
  console.log('Weekly requests at ' + config.sendHour + ':00 local time on each client\'s check-in day; ' +
    'reminder after ' + config.reminderAfterHours + 'h without a reply.');
  tick();
  setInterval(function () { tick(); }, 60 * 1000);
});
