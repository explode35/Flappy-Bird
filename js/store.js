/*
 * store.js — localStorage persistence for the Fitness Operations Engine.
 *
 * Data model:
 *   clients:  [{ id, name, email, goal, status, checkinDay, startDate, notes }]
 *   programs: [{ id, name, weeks, days, createdAt }]
 *   assignments: [{ id, clientId, programId, startDate, notes }]
 *   sessions: [{ id, clientId, assignmentId, dayIndex, date,
 *               entries: [{ exerciseIndex, name, weight, setsDone, repsDone, rpe, note }] }]
 *   checkins: [{ id, clientId, date, weight, sleep, stress, adherence, notes }]
 */
(function (global) {
  'use strict';

  var KEY = 'fitops.v1';

  function blank() {
    return { clients: [], programs: [], assignments: [], sessions: [], checkins: [] };
  }

  var state = blank();

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) {
        var data = JSON.parse(raw);
        var base = blank();
        Object.keys(base).forEach(function (k) {
          if (Array.isArray(data[k])) base[k] = data[k];
        });
        state = base;
      }
    } catch (e) {
      // Corrupt storage — start clean rather than crash, but keep a backup.
      try { global.localStorage.setItem(KEY + '.corrupt', global.localStorage.getItem(KEY)); } catch (e2) {}
      state = blank();
    }
    return state;
  }

  function save() {
    global.localStorage.setItem(KEY, JSON.stringify(state));
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

    addClient: function (data) {
      var c = {
        id: uid('cl'),
        name: data.name || 'Unnamed client',
        email: data.email || '',
        goal: data.goal || '',
        status: data.status || 'active',
        checkinDay: data.checkinDay || 'Sunday',
        startDate: data.startDate || new Date().toISOString().slice(0, 10),
        notes: data.notes || ''
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

    addProgram: function (parsed) {
      var p = {
        id: uid('pr'),
        name: parsed.name,
        weeks: parsed.weeks || 4,
        days: parsed.days || [],
        createdAt: new Date().toISOString()
      };
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
        sleep: data.sleep != null ? data.sleep : null,
        stress: data.stress != null ? data.stress : null,
        adherence: data.adherence != null ? data.adherence : null,
        notes: data.notes || ''
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
      var data = parsed && parsed.data ? parsed.data : parsed;
      var base = blank();
      Object.keys(base).forEach(function (k) {
        if (Array.isArray(data[k])) base[k] = data[k];
      });
      state = base;
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
