/* app.js — UI wiring for the Fitness Operations Engine. */
(function () {
  'use strict';

  var S = window.FitStore;
  var P = window.FitParser;
  var G = window.FitProgression;
  var D = window.FitDeliver;

  S.load();

  var lastParsed = null;       // result of the most recent Parse
  var currentClientId = null;  // client shown in the detail view

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
  }
  function todayName() {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard'); },
        function () { toast('Copy failed — select the text manually'); });
    } else {
      toast('Clipboard unavailable — select the text manually');
    }
  }

  // ---------- navigation ----------
  function show(view) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    $('view-' + view).classList.add('active');
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === view);
    });
    if (view === 'dashboard') renderDashboard();
    if (view === 'programs') renderPrograms();
    if (view === 'clients') renderClients();
  }
  document.querySelectorAll('#nav button').forEach(function (b) {
    b.addEventListener('click', function () { show(b.dataset.view); });
  });

  // ---------- dashboard ----------
  function renderDashboard() {
    var st = S.state;
    var active = st.clients.filter(function (c) { return c.status === 'active'; });
    var weekAgo = Date.now() - 7 * 86400000;
    var sessionsThisWeek = st.sessions.filter(function (s) {
      var t = Date.parse(s.date); return !isNaN(t) && t >= weekAgo;
    }).length;

    var stats = $('dash-stats');
    stats.innerHTML = '';
    [[active.length, 'Active clients'],
     [st.programs.length, 'Programs'],
     [sessionsThisWeek, 'Sessions logged (7d)'],
     [st.checkins.length, 'Check-ins on file']].forEach(function (pair) {
      stats.appendChild(el('div', 'stat', '<div class="n">' + pair[0] + '</div><div class="l">' + pair[1] + '</div>'));
    });

    // check-ins due today
    var due = active.filter(function (c) { return c.checkinDay === todayName(); });
    var box = $('dash-checkins');
    box.innerHTML = '';
    if (!due.length) box.appendChild(el('div', 'empty', 'No check-ins due today.'));
    due.forEach(function (c) {
      var row = el('div', 'suggestion');
      row.appendChild(el('span', 'act add-rep', 'Due'));
      row.appendChild(el('span', null, '<strong>' + esc(c.name) + '</strong> — ' + esc(c.goal || 'no goal set')));
      var btn = el('button', 'btn small', 'Copy check-in message');
      btn.style.marginLeft = 'auto';
      btn.addEventListener('click', function () { copyText(D.checkinMessage(c)); });
      row.appendChild(btn);
      box.appendChild(row);
    });

    // adherence flags
    var flags = $('dash-adherence');
    flags.innerHTML = '';
    var flagged = 0;
    active.forEach(function (c) {
      var a = S.activeAssignment(c.id);
      if (!a) return;
      var prog = S.getProgram(a.programId);
      var adh = G.adherence(S.sessionsForClient(c.id), prog ? prog.days.length : 3);
      if (adh.pct < 60) {
        flagged++;
        var row = el('div', 'suggestion');
        row.appendChild(el('span', 'act reduce', adh.pct + '%'));
        row.appendChild(el('span', null, '<strong>' + esc(c.name) + '</strong> — ' + adh.done + ' of ~' +
          adh.expected + ' expected sessions logged. Worth a nudge.'));
        flags.appendChild(row);
      }
    });
    if (!flagged) flags.appendChild(el('div', 'empty', 'Nobody flagged — everyone is on track (or no sessions are being logged yet).'));

    // blocks ending soon
    var ending = $('dash-ending');
    ending.innerHTML = '';
    var found = 0;
    st.assignments.forEach(function (a) {
      var prog = S.getProgram(a.programId);
      var client = S.getClient(a.clientId);
      if (!prog || !client || client.status !== 'active') return;
      var start = Date.parse(a.startDate);
      if (isNaN(start)) return;
      var end = start + prog.weeks * 7 * 86400000;
      var daysLeft = Math.ceil((end - Date.now()) / 86400000);
      if (daysLeft >= 0 && daysLeft <= 7) {
        found++;
        var row = el('div', 'suggestion');
        row.appendChild(el('span', 'act hold', daysLeft + 'd'));
        row.appendChild(el('span', null, '<strong>' + esc(client.name) + '</strong> finishes “' +
          esc(prog.name) + '” — time to write the next block.'));
        ending.appendChild(row);
      }
    });
    if (!found) ending.appendChild(el('div', 'empty', 'No blocks ending in the next 7 days.'));
  }

  // ---------- import ----------
  var SAMPLE = [
    'Program: Hypertrophy Block 1',
    'Weeks: 4',
    '',
    'Day 1 - Push',
    'Bench Press 4x8 @ RPE 7 rest 2min',
    'Incline DB Press 3x10-12 rest 90s',
    'A1. Cable Fly 3x15',
    'A2. Lateral Raise 3x15 rest 60s',
    'Triceps Pushdown 3x12-15 rest 60s',
    '- control the negative on all pressing',
    '',
    'Day 2 - Pull',
    'Deadlift 3x5 @ 80% rest 3min',
    'Chest-Supported Row 4x10 @ RPE 8 rest 2min',
    'Lat Pulldown 3x10-12 rest 90s tempo 3010',
    'B1. Face Pull 3x15',
    'B2. DB Curl 3x12 rest 60s',
    '',
    'Day 3 - Legs',
    'Back Squat 4x6 @ RPE 7-8 rest 3min',
    'Romanian Deadlift 3x8-10 rest 2min',
    'Leg Press 3x12 rest 90s',
    'Walking Lunge 2x10/side rest 90s',
    'Standing Calf Raise 4x12-15 rest 60s',
    'note: last set of leg press is AMRAP if feeling good'
  ].join('\n');

  $('btn-sample').addEventListener('click', function () {
    $('raw-text').value = SAMPLE;
    toast('Sample loaded — hit Parse');
  });
  $('btn-clear-raw').addEventListener('click', function () {
    $('raw-text').value = '';
    $('parse-result').innerHTML = '';
    lastParsed = null;
  });

  $('btn-parse').addEventListener('click', function () {
    var text = $('raw-text').value;
    lastParsed = P.parseProgram(text);
    var out = $('parse-result');
    out.innerHTML = '';

    if (lastParsed.warnings.length) {
      out.appendChild(el('div', 'warnbox', '<strong>Parser notes:</strong><br>' +
        lastParsed.warnings.map(esc).join('<br>')));
    }

    var panel = el('div', 'panel');
    panel.appendChild(el('h1', null, esc(lastParsed.name)));
    panel.appendChild(el('p', 'sub', lastParsed.weeks + '-week block · ' + lastParsed.days.length +
      ' training days' + (lastParsed.clientHint ? ' · for ' + esc(lastParsed.clientHint) : '')));
    panel.appendChild(renderProgramPreview(lastParsed));

    var row = el('div', 'btnrow');
    var save = el('button', 'btn primary', 'Save program');
    save.addEventListener('click', function () {
      if (!lastParsed.days.length) { toast('Nothing to save — no training days parsed'); return; }
      var p = S.addProgram(lastParsed);
      toast('Saved “' + p.name + '”');
      show('programs');
    });
    row.appendChild(save);
    panel.appendChild(row);
    out.appendChild(panel);
  });

  function renderProgramPreview(program) {
    var wrap = el('div');
    program.days.forEach(function (day) {
      var d = el('div', 'day');
      d.appendChild(el('h3', null, esc(day.label)));
      day.notes.forEach(function (n) { d.appendChild(el('div', 'dnote', esc(n))); });
      day.exercises.forEach(function (ex) {
        var line = el('div', 'exline');
        line.appendChild(el('span', 'ss', ex.superset ? esc(ex.superset) : ''));
        var nm = el('span', 'nm', esc(ex.name) +
          (ex.notes.length ? ' <span class="nt">— ' + esc(ex.notes.join(' · ')) + '</span>' : ''));
        line.appendChild(nm);
        line.appendChild(el('span', 'sch', esc(P.schemeLabel(ex) || '—')));
        d.appendChild(line);
      });
      wrap.appendChild(d);
    });
    return wrap;
  }

  // ---------- programs ----------
  function renderPrograms() {
    var box = $('program-list');
    box.innerHTML = '';
    $('program-detail').innerHTML = '';
    var progs = S.state.programs;
    if (!progs.length) {
      box.appendChild(el('div', 'empty', 'No programs yet — parse one under Import.'));
      return;
    }
    var table = el('table', 'list');
    table.innerHTML = '<thead><tr><th>Program</th><th>Weeks</th><th>Days</th><th>Exercises</th><th></th></tr></thead>';
    var tbody = el('tbody');
    progs.forEach(function (p) {
      var exCount = p.days.reduce(function (n, d) { return n + d.exercises.length; }, 0);
      var tr = el('tr');
      tr.innerHTML = '<td><strong>' + esc(p.name) + '</strong></td><td>' + p.weeks +
        '</td><td>' + p.days.length + '</td><td>' + exCount + '</td>';
      var td = el('td');
      td.style.textAlign = 'right';
      td.style.whiteSpace = 'nowrap';

      var view = el('button', 'btn small', 'View');
      view.addEventListener('click', function () { renderProgramDetail(p); });
      var sheet = el('button', 'btn small', 'Client sheet');
      sheet.addEventListener('click', function () {
        if (!D.programSheet(p, null, coachName())) toast('Pop-up blocked — allow pop-ups to open the sheet');
      });
      var csv = el('button', 'btn small', 'CSV');
      csv.addEventListener('click', function () {
        D.download(slug(p.name) + '.csv', D.programCSV(p), 'text/csv');
      });
      var del = el('button', 'btn small danger', 'Delete');
      del.addEventListener('click', function () {
        if (confirm('Delete “' + p.name + '”? Assignments using it are removed too.')) {
          S.deleteProgram(p.id);
          renderPrograms();
        }
      });
      [view, sheet, csv, del].forEach(function (b) { b.style.marginLeft = '6px'; td.appendChild(b); });
      tr.appendChild(td);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  function renderProgramDetail(p) {
    var box = $('program-detail');
    box.innerHTML = '';
    var panel = el('div', 'panel');
    panel.appendChild(el('h1', null, esc(p.name)));
    panel.appendChild(el('p', 'sub', p.weeks + '-week block · ' + p.days.length + ' training days'));
    panel.appendChild(renderProgramPreview(p));
    box.appendChild(panel);
    panel.scrollIntoView({ behavior: 'smooth' });
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'program';
  }
  function coachName() { return 'Your Coaching'; }

  // ---------- clients ----------
  $('btn-add-client').addEventListener('click', function () {
    var name = $('c-name').value.trim();
    if (!name) { toast('Client needs a name'); return; }
    S.addClient({
      name: name,
      email: $('c-email').value.trim(),
      goal: $('c-goal').value.trim(),
      checkinDay: $('c-checkin').value
    });
    $('c-name').value = ''; $('c-email').value = ''; $('c-goal').value = '';
    toast('Client added');
    renderClients();
  });

  function renderClients() {
    var box = $('client-list');
    box.innerHTML = '';
    var clients = S.state.clients;
    if (!clients.length) {
      box.appendChild(el('div', 'empty', 'No clients yet — add your first one above.'));
      return;
    }
    var table = el('table', 'list');
    table.innerHTML = '<thead><tr><th>Client</th><th>Goal</th><th>Check-in</th><th>Program</th><th>Adherence (14d)</th><th>Status</th></tr></thead>';
    var tbody = el('tbody');
    clients.forEach(function (c) {
      var a = S.activeAssignment(c.id);
      var prog = a ? S.getProgram(a.programId) : null;
      var adh = G.adherence(S.sessionsForClient(c.id), prog ? prog.days.length : 3);
      var adhBadge = !prog ? '<span class="badge gray">—</span>'
        : adh.pct >= 80 ? '<span class="badge good">' + adh.pct + '%</span>'
        : adh.pct >= 60 ? '<span class="badge warn">' + adh.pct + '%</span>'
        : '<span class="badge bad">' + adh.pct + '%</span>';
      var tr = el('tr', 'click');
      tr.innerHTML = '<td><strong>' + esc(c.name) + '</strong></td><td>' + esc(c.goal || '—') +
        '</td><td>' + esc(c.checkinDay) + '</td><td>' + esc(prog ? prog.name : 'Unassigned') +
        '</td><td>' + adhBadge + '</td><td><span class="badge ' +
        (c.status === 'active' ? 'good' : 'gray') + '">' + esc(c.status) + '</span></td>';
      tr.addEventListener('click', function () { openClient(c.id); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    box.appendChild(table);
  }

  $('btn-back-clients').addEventListener('click', function () { show('clients'); });

  function openClient(id) {
    currentClientId = id;
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    $('view-client').classList.add('active');
    document.querySelectorAll('#nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === 'clients');
    });
    renderClientDetail();
  }

  function renderClientDetail() {
    var c = S.getClient(currentClientId);
    var box = $('client-detail');
    box.innerHTML = '';
    if (!c) { box.appendChild(el('div', 'empty', 'Client not found.')); return; }

    var a = S.activeAssignment(c.id);
    var prog = a ? S.getProgram(a.programId) : null;

    // header panel
    var head = el('div', 'panel');
    head.appendChild(el('h1', null, esc(c.name)));
    head.appendChild(el('p', 'sub',
      esc(c.goal || 'No goal set') + ' · check-ins ' + esc(c.checkinDay) +
      (c.email ? ' · ' + esc(c.email) : '') + ' · started ' + esc(c.startDate)));
    var hrow = el('div', 'btnrow');
    var toggle = el('button', 'btn small', c.status === 'active' ? 'Pause client' : 'Reactivate');
    toggle.addEventListener('click', function () {
      S.updateClient(c.id, { status: c.status === 'active' ? 'paused' : 'active' });
      renderClientDetail();
    });
    var del = el('button', 'btn small danger', 'Delete client');
    del.addEventListener('click', function () {
      if (confirm('Delete ' + c.name + ' and all their data?')) {
        S.deleteClient(c.id);
        show('clients');
      }
    });
    hrow.appendChild(toggle); hrow.appendChild(del);
    head.appendChild(hrow);
    box.appendChild(head);

    // assignment panel
    var ap = el('div', 'panel');
    ap.appendChild(el('h2', null, 'Current program'));
    if (prog) {
      var start = Date.parse(a.startDate);
      var week = isNaN(start) ? '?' : Math.min(prog.weeks, Math.max(1, Math.floor((Date.now() - start) / (7 * 86400000)) + 1));
      ap.appendChild(el('p', null, '<strong>' + esc(prog.name) + '</strong> — week ' + week + ' of ' +
        prog.weeks + ' (started ' + esc(a.startDate) + ')'));
    } else {
      ap.appendChild(el('div', 'empty', 'No program assigned yet.'));
    }
    var arow = el('div', 'btnrow');
    if (S.state.programs.length) {
      var sel = el('select');
      sel.style.maxWidth = '280px';
      S.state.programs.forEach(function (p) {
        var o = el('option', null, esc(p.name));
        o.value = p.id;
        sel.appendChild(o);
      });
      var assignBtn = el('button', 'btn primary small', prog ? 'Assign new block' : 'Assign program');
      assignBtn.addEventListener('click', function () {
        S.assignProgram(c.id, sel.value);
        toast('Program assigned');
        renderClientDetail();
      });
      arow.appendChild(sel); arow.appendChild(assignBtn);
    } else {
      arow.appendChild(el('span', 'empty', 'Parse a program under Import first.'));
    }
    if (a) {
      var unassign = el('button', 'btn small danger', 'Remove assignment');
      unassign.addEventListener('click', function () {
        if (confirm('Remove this assignment and its logged sessions?')) {
          S.deleteAssignment(a.id);
          renderClientDetail();
        }
      });
      arow.appendChild(unassign);
    }
    ap.appendChild(arow);
    box.appendChild(ap);

    // deliverables panel
    var dp = el('div', 'panel');
    dp.appendChild(el('h2', null, 'Deliver'));
    var drow = el('div', 'btnrow');
    var sheetBtn = el('button', 'btn small', 'Program sheet (print/PDF)');
    sheetBtn.disabled = !prog;
    sheetBtn.addEventListener('click', function () {
      if (!D.programSheet(prog, c, coachName())) toast('Pop-up blocked — allow pop-ups to open the sheet');
    });
    var formBtn = el('button', 'btn small', 'Check-in form (print/PDF)');
    formBtn.addEventListener('click', function () {
      if (!D.checkinForm(c, coachName())) toast('Pop-up blocked — allow pop-ups to open the form');
    });
    var msgBtn = el('button', 'btn small', 'Copy check-in message');
    msgBtn.addEventListener('click', function () { copyText(D.checkinMessage(c)); });
    var welBtn = el('button', 'btn small', 'Copy welcome message');
    welBtn.addEventListener('click', function () { copyText(D.welcomeMessage(c, prog)); });
    var csvBtn = el('button', 'btn small', 'Program CSV');
    csvBtn.disabled = !prog;
    csvBtn.addEventListener('click', function () {
      D.download(slug(prog.name) + '-' + slug(c.name) + '.csv', D.programCSV(prog), 'text/csv');
    });
    [sheetBtn, formBtn, msgBtn, welBtn, csvBtn].forEach(function (b) { drow.appendChild(b); });
    dp.appendChild(drow);
    box.appendChild(dp);

    // session logging panel
    if (prog) box.appendChild(renderSessionPanel(c, a, prog));

    // check-in panel
    box.appendChild(renderCheckinPanel(c));
  }

  function renderSessionPanel(client, assignment, prog) {
    var panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'Log session'));

    var row = el('div', 'btnrow');
    var daySel = el('select');
    daySel.style.maxWidth = '280px';
    prog.days.forEach(function (d, i) {
      var o = el('option', null, esc(d.label));
      o.value = i;
      daySel.appendChild(o);
    });
    var dateIn = el('input');
    dateIn.type = 'date';
    dateIn.style.maxWidth = '170px';
    dateIn.value = new Date().toISOString().slice(0, 10);
    row.appendChild(daySel); row.appendChild(dateIn);
    panel.appendChild(row);

    var gridWrap = el('div');
    panel.appendChild(gridWrap);

    function renderGrid() {
      gridWrap.innerHTML = '';
      var day = prog.days[parseInt(daySel.value, 10)];
      var table = el('table', 'list loggrid');
      table.innerHTML = '<thead><tr><th>Exercise</th><th>Target</th><th>Weight</th><th>Last-set reps</th><th>RPE</th></tr></thead>';
      var tbody = el('tbody');
      day.exercises.forEach(function (ex, i) {
        var tr = el('tr');
        tr.innerHTML = '<td>' + esc(ex.name) + '</td><td style="color:var(--muted)">' +
          esc(P.schemeLabel(ex) || '—') + '</td>';
        ['weight', 'reps', 'rpe'].forEach(function (field) {
          var td = el('td');
          var input = el('input');
          input.type = 'number';
          input.step = field === 'weight' ? '0.5' : field === 'rpe' ? '0.5' : '1';
          input.dataset.ex = i;
          input.dataset.field = field;
          td.appendChild(input);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      gridWrap.appendChild(table);
    }
    daySel.addEventListener('change', renderGrid);
    renderGrid();

    var suggBox = el('div');
    var save = el('button', 'btn primary', 'Save session & suggest progressions');
    save.style.marginTop = '12px';
    save.addEventListener('click', function () {
      var dayIndex = parseInt(daySel.value, 10);
      var day = prog.days[dayIndex];
      var entries = [];
      day.exercises.forEach(function (ex, i) {
        var get = function (f) {
          var inp = gridWrap.querySelector('input[data-ex="' + i + '"][data-field="' + f + '"]');
          return inp && inp.value !== '' ? inp.value : null;
        };
        entries.push({
          exerciseIndex: i, name: ex.name,
          weight: get('weight'), repsDone: get('reps'), rpe: get('rpe')
        });
      });
      var logged = entries.filter(function (e) { return e.weight != null || e.repsDone != null || e.rpe != null; });
      if (!logged.length) { toast('Enter at least one weight/reps value'); return; }
      S.logSession({
        clientId: client.id, assignmentId: assignment.id,
        dayIndex: dayIndex, date: dateIn.value, entries: entries
      });
      toast('Session saved');

      suggBox.innerHTML = '';
      suggBox.appendChild(el('h2', null, 'Next time'));
      var list = el('div');
      day.exercises.forEach(function (ex, i) {
        var entry = entries[i];
        if (entry.weight == null && entry.repsDone == null && entry.rpe == null) return;
        var sug = G.suggest(ex, entry);
        var line = el('div', 'suggestion');
        line.appendChild(el('span', 'act ' + sug.action, sug.action.replace('-', ' ')));
        var detail = '<strong>' + esc(ex.name) + '</strong> — ' + esc(sug.reason);
        if (sug.nextWeight != null) detail += ' <span style="color:var(--muted)">(→ ' + sug.nextWeight + ')</span>';
        line.appendChild(el('span', null, detail));
        list.appendChild(line);
      });
      suggBox.appendChild(list);
    });
    panel.appendChild(save);
    panel.appendChild(suggBox);

    // recent sessions
    var sessions = S.sessionsForClient(client.id).slice(-5).reverse();
    if (sessions.length) {
      panel.appendChild(el('h2', null, 'Recent sessions'));
      var hist = el('div');
      sessions.forEach(function (s) {
        var day = s.dayIndex != null && prog.days[s.dayIndex] ? prog.days[s.dayIndex].label : 'Session';
        var tops = s.entries.filter(function (e) { return e.weight != null; }).slice(0, 3)
          .map(function (e) { return esc(e.name) + ' ' + esc(e.weight) + '×' + esc(e.repsDone != null ? e.repsDone : '?'); })
          .join(', ');
        hist.appendChild(el('div', 'suggestion',
          '<span class="act add-rep">' + esc(s.date) + '</span><span><strong>' + esc(day) + '</strong>' +
          (tops ? ' — ' + tops : '') + '</span>'));
      });
      panel.appendChild(hist);
    }
    return panel;
  }

  function renderCheckinPanel(client) {
    var panel = el('div', 'panel');
    panel.appendChild(el('h2', null, 'Record check-in'));
    var row = el('div', 'row');
    var fields = [
      ['ci-date', 'Date', 'date'],
      ['ci-weight', 'Body weight', 'number'],
      ['ci-sleep', 'Sleep (hrs)', 'number'],
      ['ci-stress', 'Stress 1–5', 'number'],
      ['ci-adh', 'Nutrition 1–5', 'number']
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var wrap = el('div');
      wrap.appendChild(el('label', 'f', f[1]));
      var input = el('input');
      input.type = f[2];
      if (f[2] === 'number') input.step = '0.5';
      if (f[2] === 'date') input.value = new Date().toISOString().slice(0, 10);
      inputs[f[0]] = input;
      wrap.appendChild(input);
      row.appendChild(wrap);
    });
    panel.appendChild(row);
    panel.appendChild(el('label', 'f', 'Notes / coach reply'));
    var notes = el('textarea');
    notes.rows = 2;
    panel.appendChild(notes);
    var save = el('button', 'btn primary', 'Save check-in');
    save.style.marginTop = '12px';
    save.addEventListener('click', function () {
      var num = function (k) { return inputs[k].value !== '' ? parseFloat(inputs[k].value) : null; };
      S.logCheckin({
        clientId: client.id, date: inputs['ci-date'].value,
        weight: num('ci-weight'), sleep: num('ci-sleep'),
        stress: num('ci-stress'), adherence: num('ci-adh'), notes: notes.value.trim()
      });
      toast('Check-in saved');
      renderClientDetail();
    });
    panel.appendChild(save);

    var history = S.checkinsForClient(client.id).slice(-6).reverse();
    if (history.length) {
      panel.appendChild(el('h2', null, 'Check-in history'));
      var table = el('table', 'list');
      table.innerHTML = '<thead><tr><th>Date</th><th>Weight</th><th>Sleep</th><th>Stress</th><th>Nutrition</th><th>Notes</th></tr></thead>';
      var tbody = el('tbody');
      history.forEach(function (ci) {
        var v = function (x) { return x != null ? esc(x) : '—'; };
        tbody.appendChild(el('tr', null, '<td>' + esc(ci.date) + '</td><td>' + v(ci.weight) +
          '</td><td>' + v(ci.sleep) + '</td><td>' + v(ci.stress) + '</td><td>' + v(ci.adherence) +
          '</td><td style="color:var(--muted)">' + esc(ci.notes || '') + '</td>'));
      });
      table.appendChild(tbody);
      panel.appendChild(table);
    }
    return panel;
  }

  // ---------- backup ----------
  $('btn-export').addEventListener('click', function () {
    D.download('fitops-backup-' + new Date().toISOString().slice(0, 10) + '.json',
      S.exportJSON(), 'application/json');
  });
  $('btn-import-backup').addEventListener('click', function () { $('file-backup').click(); });
  $('file-backup').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        S.importJSON(reader.result);
        toast('Backup restored');
        show('dashboard');
      } catch (err) {
        toast('Restore failed — not a valid backup file');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  // ---------- boot ----------
  renderDashboard();
})();
