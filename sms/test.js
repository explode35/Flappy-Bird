/* Unit tests for the SMS sequence engine. Run:  node sms/test.js */
'use strict';

var engine = require('./engine');

var passed = 0, failed = 0;
function eq(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
  } else {
    failed++;
    console.error('FAIL ' + name + ' — got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected));
  }
}

// ---------- phone matching ----------
eq('phones: formatting ignored', engine.phonesMatch('+1 (555) 123-4567', '15551234567'), true);
eq('phones: country code optional', engine.phonesMatch('555-123-4567', '+15551234567'), true);
eq('phones: different numbers', engine.phonesMatch('+15551234567', '+15559876543'), false);
eq('phones: empty', engine.phonesMatch('', '+15551234567'), false);

var clients = [
  { id: 'c1', name: 'Sarah Nguyen', phone: '+1 555 123 4567', status: 'active', checkinDay: 'Sunday', smsConsent: true, portalToken: 'tok1' },
  { id: 'c2', name: 'Marc Ito', phone: '', status: 'active', checkinDay: 'Sunday', smsConsent: true },
  { id: 'c3', name: 'Dee Cole', phone: '+15550001111', status: 'paused', checkinDay: 'Sunday', smsConsent: true }
];
eq('find by phone', engine.findClientByPhone(clients, '15551234567').id, 'c1');
eq('find by phone: none', engine.findClientByPhone(clients, '+15557778888'), null);

// ---------- plan: weekly request ----------
var cfg = { sendHour: 8, reminderAfterHours: 6 };
// 2026-07-19 is a Sunday
var sundayMorning = new Date(2026, 6, 19, 9, 0, 0);
var sundayEarly = new Date(2026, 6, 19, 7, 0, 0);
var monday = new Date(2026, 6, 20, 9, 0, 0);

var st = { clients: clients, smsSequences: [] };
var actions = engine.plan(st, cfg, sundayMorning);
eq('request due on check-in day', actions, [{ type: 'request', clientId: 'c1' }]);
eq('no request before sendHour', engine.plan(st, cfg, sundayEarly), []);
eq('no request on other days', engine.plan(st, cfg, monday), []);

eq('no request without consent', engine.plan({ clients: [
  { id: 'x', name: 'No Consent', phone: '+15551112222', status: 'active', checkinDay: 'Sunday', smsConsent: false }
], smsSequences: [] }, cfg, sundayMorning), []);

st.smsSequences = [{ id: 'q1', clientId: 'c1', date: engine.dateKey(sundayMorning),
                     requestSentAt: sundayMorning.toISOString(), reminderSentAt: null, repliedAt: null }];
eq('no duplicate request same day', engine.plan(st, cfg, new Date(2026, 6, 19, 11, 0, 0)), []);

// ---------- plan: reminder ----------
var sevenHoursLater = new Date(2026, 6, 19, 16, 0, 0);
actions = engine.plan(st, cfg, sevenHoursLater);
eq('reminder after quiet hours', actions, [{ type: 'reminder', clientId: 'c1', sequenceId: 'q1' }]);

st.smsSequences[0].reminderSentAt = sevenHoursLater.toISOString();
eq('only one reminder', engine.plan(st, cfg, new Date(2026, 6, 19, 20, 0, 0)), []);

st.smsSequences[0].reminderSentAt = null;
st.smsSequences[0].repliedAt = new Date(2026, 6, 19, 10, 0, 0).toISOString();
eq('no reminder after reply', engine.plan(st, cfg, sevenHoursLater), []);

st.smsSequences[0].repliedAt = null;
eq('no reminder after 48h', engine.plan(st, cfg, new Date(2026, 6, 22, 9, 0, 0)), []);

// ---------- reply parsing ----------
var r = engine.parseReply('1. 72.5\n2. 4\n3. 7h sleep, stress 2\n4. 4\n5. Win: bench PR. Struggle: late nights');
eq('numbered: weight', r.weight, 72.5);
eq('numbered: sessions', r.sessions, 4);
eq('numbered: sleep', r.sleep, 7);
eq('numbered: stress', r.stress, 2);
eq('numbered: adherence', r.adherence, 4);
eq('numbered: notes', r.notes, 'Win: bench PR. Struggle: late nights');

r = engine.parseReply('weight 71.8, trained 3 times, slept 6.5, stress 4, nutrition 3 — rough week');
eq('labeled: weight', r.weight, 71.8);
eq('labeled: sessions', r.sessions, 3);
eq('labeled: sleep', r.sleep, 6.5);
eq('labeled: stress', r.stress, 4);
eq('labeled: adherence', r.adherence, 3);

r = engine.parseReply('72.5 4 7 2 4');
eq('bare numbers: weight', r.weight, 72.5);
eq('bare numbers: sessions', r.sessions, 4);
eq('bare numbers: adherence', r.adherence, 4);

r = engine.parseReply('Sorry coach, sick all week, no training');
eq('text only: no weight', r.weight, null);
eq('text only: notes kept', r.notes, 'Sorry coach, sick all week, no training');

eq('empty reply', engine.parseReply('').weight, null);

// ---------- messages ----------
var sarah = clients[0];
var req = engine.buildRequest(sarah, 'Iron Path Coaching');
eq('request greets by first name', req.indexOf('Hey Sarah!'), 0);
eq('request numbers the questions', /1\. Morning weight/.test(req), true);

var conf = engine.buildConfirmation({ weight: 72.5, sessions: 4, sleep: 7, stress: 2, adherence: 4, notes: '' }, sarah);
eq('confirmation lists values', /weight 72\.5, 4 sessions, sleep 7h, stress 2, nutrition 4/.test(conf), true);
var conf2 = engine.buildConfirmation({ weight: null, sessions: null, sleep: null, stress: null, adherence: null, notes: 'sick' }, sarah);
eq('confirmation without values', /Check-in received/.test(conf2), true);

// ---------- state merge ----------
var serverState = {
  clients: [clients[0]],
  checkins: [
    { id: 'ch_ui', clientId: 'c1', weight: 70 },
    { id: 'ch_sms', clientId: 'c1', weight: 72.5, source: 'sms' }
  ],
  smsSequences: [{ id: 'q1' }],
  smsLog: [{ id: 'sm1' }]
};
var clientPut = { clients: [clients[0], clients[1]], checkins: [{ id: 'ch_ui', clientId: 'c1', weight: 70 }] };
var merged = engine.mergeState(serverState, clientPut);
eq('merge: UI owns clients', merged.clients.length, 2);
eq('merge: server sms checkin preserved', merged.checkins.some(function (c) { return c.id === 'ch_sms'; }), true);
eq('merge: server owns sequences', merged.smsSequences, [{ id: 'q1' }]);
eq('merge: server owns log', merged.smsLog, [{ id: 'sm1' }]);
var merged2 = engine.mergeState(serverState, { clients: [], checkins: [] });
eq('merge: UI deletions of its own data respected', merged2.checkins.length, 1);

// ---------- opt-out / opt-in ----------
eq('opt-out: STOP', engine.isOptOut('STOP'), true);
eq('opt-out: unsubscribe', engine.isOptOut('Unsubscribe'), true);
eq('opt-out: normal reply', engine.isOptOut('72.5 4 7 2 4'), false);
eq('opt-in: START', engine.isOptIn('START'), true);
eq('opt-in: yes', engine.isOptIn('yes'), true);

// ---------- portal ----------
var portalState = {
  clients: [
    { id: 'c1', name: 'Sarah Nguyen', phone: '+15551234567', email: 'sarah@x.com',
      status: 'active', checkinDay: 'Sunday', portalToken: 'tok1' },
    { id: 'c3', name: 'Dee Cole', status: 'paused', portalToken: 'tok3' }
  ],
  assignments: [{ id: 'a1', clientId: 'c1', programId: 'p1', startDate: '2026-07-01' }],
  programs: [{ id: 'p1', name: 'Block 1', weeks: 4, days: [{ label: 'Day 1', blocks: [] }] }]
};
eq('portal: find by token', engine.findClientByToken(portalState.clients, 'tok1').id, 'c1');
eq('portal: unknown token', engine.findClientByToken(portalState.clients, 'nope'), null);
var view = engine.portalView(portalState, 'tok1', 'Iron Path Coaching');
eq('portal: coach name', view.coachName, 'Iron Path Coaching');
eq('portal: client name only', view.client.name, 'Sarah Nguyen');
eq('portal: no phone leaked', view.client.phone, undefined);
eq('portal: no email leaked', view.client.email, undefined);
eq('portal: program name', view.program.name, 'Block 1');
eq('portal: paused client no view', engine.portalView(portalState, 'tok3', 'X'), null);
eq('portal: unknown token no view', engine.portalView(portalState, 'nope', 'X'), null);
var noProg = engine.portalView({ clients: [{ id: 'c9', name: 'New', status: 'active', portalToken: 'tok9' }],
  assignments: [], programs: [] }, 'tok9', 'X');
eq('portal: unassigned -> null program', noProg.program, null);
eq('portal: url built', engine.portalUrl('https://coach.example.com/', { portalToken: 'tok1' }),
   'https://coach.example.com/p/tok1');

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
