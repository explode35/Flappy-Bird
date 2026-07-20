/*
 * store.js — localStorage persistence for the Fitness Operations Engine.
 *
 * Data model:
 *   clients:  [{ id, name, email, phone, goal, status, checkinDay, startDate,
 *               notes, portalToken, smsConsent }]
 *   programs: [{ id, name, weeks, days:[{label,notes,blocks:[...]}], createdAt }]
 *   assignments: [{ id, clientId, programId, startDate, notes }]
 *   sessions: [{ id, clientId, assignmentId, dayIndex, date,
 *               entries: [{ exerciseIndex, name, weight, setsDone, repsDone, rpe, note }] }]
 *   checkins: [{ id, clientId, date, weight, sessions, sleep, stress, adherence,
 *               notes, source }]
 */
(function (global) {
  'use strict';

  var KEY = 'fitops.v1';

  function blank() {
    return { clients: [], programs: [], assignments: [], sessions: [], checkins: [],
             smsSequences: [], smsLog: [] };
  }

  var state = blank();

  // Remote sync: when the app is served by sms/server.js, state lives
  // server-side so the SMS engine and the UI share one store.
  var remote = false;
  var lastRev = 0;
  var pushTimer = null;
  var pollTimer = null;
  var onRemoteChange = null;

  function fromRaw(data) {
    var base = blank();
    Object.keys(base).forEach(function (k) {
      if (Array.isArray(data[k])) base[k] = data[k];
    });
    // Migrate legacy programs (pre-blocks) and back-fill client portal tokens
    // so data written by an older version keeps working.
    base.programs.forEach(function (p) {
      if (p.days && global.FitParser && global.FitParser.migrateDays) {
        global.FitParser.migrateDays(p.days);
      }
    });
    base.clients.forEach(function (c) {
      if (!c.portalToken) c.portalToken = makeToken();
    });
    return base;
  }

  function makeToken() {
    var s = '';
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    var rnd;
    if (global.crypto && global.crypto.getRandomValues) {
      rnd = new Uint8Array(16);
      global.crypto.getRandomValues(rnd);
    } else {
      rnd = [];
      for (var j = 0; j < 16; j++) rnd.push(Math.floor(Math.random() * 256));
    }
    for (var i = 0; i < rnd.length; i++) s += chars[rnd[i] % chars.length];
    return s;
  }

  function applyRemote(res) {
    if (!res || !res.data) return;
    lastRev = res.rev || lastRev;
    var merged = fromRaw(res.data);
    if (JSON.stringify(merged) !== JSON.stringify(state)) {
      state = merged;
      try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      if (onRemoteChange) onRemoteChange();
    }
  }

  function schedulePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () {
      fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: state })
      }).then(function (r) { return r.json(); })
        .then(applyRemote)
        .catch(function () {});
    }, 400);
  }

  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(function () {
      fetch('/api/state')
        .then(function (r) { if (!r.ok) throw new Error('offline'); return r.json(); })
        .then(function (res) { if (res.rev !== lastRev) applyRemote(res); })
        .catch(function () {});
    }, 15000);
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) state = fromRaw(JSON.parse(raw));
    } catch (e) {
      // Corrupt storage — start clean rather than crash, but keep a backup.
      try { global.localStorage.setItem(KEY + '.corrupt', global.localStorage.getItem(KEY)); } catch (e2) {}
      state = blank();
    }
    return state;
  }

  function save() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
    if (remote) schedulePush();
  }

  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function findById(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function removeById(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list.splice(i, 1); return true; }
    }
    return false;
  }

  var api = {
    load: load,
    save: save,
    get state() { return state; },

    /**
     * Try to attach to the SMS engine's shared store (/api/state). Resolves
     * true when connected; cb fires whenever server-side changes arrive.
     */
    connectRemote: function (cb) {
      onRemoteChange = cb || null;
      if (typeof fetch !== 'function') return Promise.resolve(false);
      // Only probe for the SMS engine when served over HTTP (file:// can't
      // reach /api/state and just spams the console with CORS errors).
      if (global.location && !/^https?:$/.test(global.location.protocol)) {
        return Promise.resolve(false);
      }
      return fetch('/api/state')
        .then(function (r) { if (!r.ok) throw new Error('offline'); return r.json(); })
        .then(function (res) {
          remote = true;
          lastRev = res.rev || 1;
          var server = fromRaw(res.data || {});
          var serverEmpty = !server.clients.length && !server.programs.length && !server.checkins.length;
          var localHasData = state.clients.length || state.programs.length;
          if (serverEmpty && localHasData) {
            schedulePush(); // first run against a fresh server: seed it from local
          } else {
            state = server;
            try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
          }
          startPolling();
          return true;
        })
        .catch(function () { return false; });
    },
    isRemote: function () { return remote; },

    addClient: function (data) {
      var c = {
        id: uid('cl'),
        name: data.name || 'Unnamed client',
        email: data.email || '',
        phone: data.phone || '',
        goal: data.goal || '',
        status: data.status || 'active',
        checkinDay: data.checkinDay || 'Sunday',
        startDate: data.startDate || new Date().toISOString().slice(0, 10),
        notes: data.notes || '',
        portalToken: makeToken(),
        smsConsent: data.smsConsent || false
      };
      state.clients.push(c);
      save();
      return c;
    },
    updateClient: function (id, data) {
      var c = findById(state.clients, id);
      if (!c) return null;
      Object.keys(data).forEach(function (k) { if (k !== 'id') c[k] = data[k]; });
      save();
      return c;
    },
    deleteClient: function (id) {
      removeById(state.clients, id);
      state.assignments = state.assignments.filter(function (a) { return a.clientId !== id; });
      state.sessions = state.sessions.filter(function (s) { return s.clientId !== id; });
      state.checkins = state.checkins.filter(function (c) { return c.clientId !== id; });
      save();
    },
    getClient: function (id) { return findById(state.clients, id); },
    getClientByToken: function (token) {
      if (!token) return null;
      for (var i = 0; i < state.clients.length; i++) {
        if (state.clients[i].portalToken === token) return state.clients[i];
      }
      return null;
    },

    addProgram: function (parsed) {
      var p = {
        id: uid('pr'),
        name: parsed.name,
        weeks: parsed.weeks || 4,
        days: parsed.days || [],
        createdAt: new Date().toISOString()
      };
      if (global.FitParser && global.FitParser.migrateDays) global.FitParser.migrateDays(p.days);
      state.programs.push(p);
      save();
      return p;
    },
    updateProgram: function (id, data) {
      var p = findById(state.programs, id);
      if (!p) return null;
      Object.keys(data).forEach(function (k) { if (k !== 'id') p[k] = data[k]; });
      save();
      return p;
    },
    deleteProgram: function (id) {
      removeById(state.programs, id);
      state.assignments = state.assignments.filter(function (a) { return a.programId !== id; });
      save();
    },
    getProgram: function (id) { return findById(state.programs, id); },

    assignProgram: function (clientId, programId, startDate) {
      var a = {
        id: uid('as'),
        clientId: clientId,
        programId: programId,
        startDate: startDate || new Date().toISOString().slice(0, 10),
        notes: ''
      };
      state.assignments.push(a);
      save();
      return a;
    },
    deleteAssignment: function (id) {
      removeById(state.assignments, id);
      state.sessions = state.sessions.filter(function (s) { return s.assignmentId !== id; });
      save();
    },
    getAssignment: function (id) { return findById(state.assignments, id); },
    assignmentsForClient: function (clientId) {
      return state.assignments.filter(function (a) { return a.clientId === clientId; });
    },
    activeAssignment: function (clientId) {
      var list = api.assignmentsForClient(clientId);
      return list.length ? list[list.length - 1] : null;
    },

    logSession: function (data) {
      var s = {
        id: uid('se'),
        clientId: data.clientId,
        assignmentId: data.assignmentId || null,
        dayIndex: data.dayIndex != null ? data.dayIndex : null,
        date: data.date || new Date().toISOString().slice(0, 10),
        entries: data.entries || []
      };
      state.sessions.push(s);
      save();
      return s;
    },
    sessionsForClient: function (clientId) {
      return state.sessions.filter(function (s) { return s.clientId === clientId; });
    },

    logCheckin: function (data) {
      var c = {
        id: uid('ch'),
        clientId: data.clientId,
        date: data.date || new Date().toISOString().slice(0, 10),
        weight: data.weight != null ? data.weight : null,
        sessions: data.sessions != null ? data.sessions : null,
        sleep: data.sleep != null ? data.sleep : null,
        stress: data.stress != null ? data.stress : null,
        adherence: data.adherence != null ? data.adherence : null,
        notes: data.notes || '',
        source: data.source || 'manual'
      };
      state.checkins.push(c);
      save();
      return c;
    },
    checkinsForClient: function (clientId) {
      return state.checkins.filter(function (c) { return c.clientId === clientId; });
    },

    exportJSON: function () {
      return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), data: state }, null, 2);
    },
    importJSON: function (text) {
      var parsed = JSON.parse(text);
      state = fromRaw(parsed && parsed.data ? parsed.data : parsed);
      save();
      return state;
    },
    reset: function () {
      state = blank();
      save();
    }
  };

  global.FitStore = api;
})(typeof window !== 'undefined' ? window : this);
