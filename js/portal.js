/*
 * portal.js — the client-facing workout portal.
 *
 * Loaded by portal.html, served at /p/<token>. Fetches a token-scoped view of
 * one client's assigned program from /api/portal and renders a mobile-first
 * dashboard where every block states its format (AMRAP / Tabata / EMOM / For
 * Time / Circuit / straight sets) up front, with a built-in timer for the
 * timed pieces so the client never has to guess what the session is.
 */
(function () {
  'use strict';

  var FP = window.FitParser;
  var token = getToken();
  var data = null;
  var timer = null;

  function getToken() {
    var m = location.pathname.match(/\/p\/([A-Za-z0-9]+)/);
    if (m) return m[1];
    var q = new URLSearchParams(location.search);
    return q.get('t') || '';
  }

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

  // ---------- load ----------
  function boot() {
    if (!token) { fail('This link is missing its access code. Ask your coach to resend it.'); return; }
    fetch('/api/portal?t=' + encodeURIComponent(token))
      .then(function (r) {
        if (r.status === 404) throw new Error('notfound');
        if (!r.ok) throw new Error('offline');
        return r.json();
      })
      .then(function (res) { data = res; render(); })
      .catch(function (err) {
        if (err.message === 'notfound') fail('We couldn’t find your portal. Double-check the link, or ask your coach to resend it.');
        else fail('Couldn’t load your workouts right now. Check your connection and try again.');
      });
  }

  function fail(msg) {
    $('portal').innerHTML = '';
    var box = el('div', 'card center');
    box.appendChild(el('div', 'muted', esc(msg)));
    $('portal').appendChild(box);
  }

  // ---------- render ----------
  function render() {
    var root = $('portal');
    root.innerHTML = '';

    document.title = (data.program ? data.program.name : 'Workouts') + ' · ' + data.coachName;

    var head = el('div', 'phead');
    head.appendChild(el('div', 'coach', esc(data.coachName)));
    head.appendChild(el('h1', null, 'Hi ' + esc(firstName(data.client.name)) + ' 👋'));
    if (data.program) {
      head.appendChild(el('div', 'pmeta', esc(data.program.name) + ' · ' +
        data.program.weeks + '-week block · ' + data.program.days.length + ' days/week'));
    }
    root.appendChild(head);

    if (!data.program) {
      var c = el('div', 'card center');
      c.appendChild(el('div', 'muted', 'Your coach hasn’t assigned a program yet. Sit tight — it’s coming.'));
      root.appendChild(c);
      renderCheckinCard(root);
      return;
    }

    // Day selector
    var tabs = el('div', 'daytabs');
    data.program.days.forEach(function (day, i) {
      var t = el('button', 'daytab' + (i === 0 ? ' active' : ''), esc(shortDay(day.label)));
      t.addEventListener('click', function () {
        tabs.querySelectorAll('.daytab').forEach(function (b) { b.classList.remove('active'); });
        t.classList.add('active');
        renderDay(day);
      });
      tabs.appendChild(t);
    });
    root.appendChild(tabs);

    var dayWrap = el('div');
    dayWrap.id = 'day-wrap';
    root.appendChild(dayWrap);
    renderDay(data.program.days[0]);

    renderCheckinCard(root);
  }

  function renderDay(day) {
    var wrap = $('day-wrap');
    wrap.innerHTML = '';

    var title = el('h2', 'dtitle', esc(day.label));
    wrap.appendChild(title);
    (day.notes || []).forEach(function (n) { wrap.appendChild(el('div', 'dnote', esc(n))); });

    (day.blocks || []).forEach(function (block) {
      wrap.appendChild(renderBlock(block));
    });
  }

  function renderBlock(block) {
    var card = el('div', 'card block fmt-' + block.format);

    var isTimed = block.format === 'amrap' || block.format === 'emom' ||
      block.format === 'tabata' || block.format === 'fortime';

    // Format banner — the whole point: style is explicit before you start.
    if (block.format !== 'standard' || block.label) {
      var banner = el('div', 'banner');
      var tagText = block.format === 'standard' ? block.label : FP.formatLabel(block);
      banner.appendChild(el('span', 'tag', esc(tagText)));
      if (block.format !== 'standard') {
        banner.appendChild(el('span', 'exp', esc(FP.formatExplainer(block))));
      }
      card.appendChild(banner);
    }

    (block.notes || []).forEach(function (n) { card.appendChild(el('div', 'bnote', esc(n))); });

    var list = el('div', 'exlist');
    var lastGroup = null;
    block.exercises.forEach(function (ex) {
      var row = el('div', 'ex');
      if (ex.superset) {
        var badge = el('span', 'ssbadge', esc(ex.superset));
        badge.style.visibility = ex.superset === lastGroup ? 'hidden' : 'visible';
        row.appendChild(badge);
        lastGroup = ex.superset;
      }
      var main = el('div', 'exmain');
      main.appendChild(el('div', 'exname', esc(ex.name)));
      var scheme = FP.schemeLabel(ex);
      if (scheme) main.appendChild(el('div', 'exscheme', esc(scheme)));
      if (ex.notes && ex.notes.length) main.appendChild(el('div', 'exnote', esc(ex.notes.join(' · '))));
      row.appendChild(main);
      list.appendChild(row);
    });
    card.appendChild(list);

    if (isTimed) {
      var startBtn = el('button', 'btn timer-btn', '▶ Start ' + FP.formatLabel(block).split(' · ')[0] + ' timer');
      startBtn.addEventListener('click', function () { openTimer(block); });
      card.appendChild(startBtn);
    }

    return card;
  }

  // ---------- check-in ----------
  function renderCheckinCard(root) {
    var card = el('div', 'card checkin-card');
    card.appendChild(el('h2', 'dtitle', 'Weekly check-in'));
    card.appendChild(el('div', 'muted', 'Due ' + esc(data.client.checkinDay) +
      '. Takes 20 seconds — it’s how your coach tunes next week.'));

    var form = el('div', 'ci-form');
    var fields = [
      ['weight', 'Body weight', 'number', '0.1'],
      ['sessions', 'Sessions done', 'number', '1'],
      ['sleep', 'Avg sleep (hrs)', 'number', '0.5'],
      ['stress', 'Stress 1–5', 'number', '1'],
      ['adherence', 'Nutrition 1–5', 'number', '1']
    ];
    var inputs = {};
    fields.forEach(function (f) {
      var w = el('label', 'ci-field');
      w.appendChild(el('span', null, f[1]));
      var input = el('input');
      input.type = f[2];
      input.step = f[3];
      input.inputMode = 'decimal';
      inputs[f[0]] = input;
      w.appendChild(input);
      form.appendChild(w);
    });
    card.appendChild(form);

    var notesW = el('label', 'ci-field wide');
    notesW.appendChild(el('span', null, 'Wins, struggles, anything hurting?'));
    var notes = el('textarea');
    notes.rows = 3;
    notesW.appendChild(notes);
    card.appendChild(notesW);

    var btn = el('button', 'btn primary block-btn', 'Send check-in');
    var status = el('div', 'ci-status');
    btn.addEventListener('click', function () {
      var num = function (k) { return inputs[k].value !== '' ? parseFloat(inputs[k].value) : null; };
      var payload = {
        weight: num('weight'), sessions: num('sessions'), sleep: num('sleep'),
        stress: num('stress'), adherence: num('adherence'), notes: notes.value.trim()
      };
      if (payload.weight == null && payload.sessions == null && !payload.notes) {
        status.textContent = 'Add at least your weight or a note.';
        status.className = 'ci-status err';
        return;
      }
      btn.disabled = true;
      status.textContent = 'Sending…';
      status.className = 'ci-status';
      fetch('/api/portal/checkin?t=' + encodeURIComponent(token), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (!r.ok) throw new Error('failed');
        return r.json();
      }).then(function () {
        card.innerHTML = '';
        card.appendChild(el('h2', 'dtitle', 'Check-in sent ✓'));
        card.appendChild(el('div', 'muted', 'Thanks! Your coach will review and adjust next week. See you in the gym.'));
      }).catch(function () {
        btn.disabled = false;
        status.textContent = 'Couldn’t send — check your connection and try again.';
        status.className = 'ci-status err';
      });
    });
    card.appendChild(btn);
    card.appendChild(status);
    root.appendChild(card);
  }

  // ---------- timer ----------
  function openTimer(block) {
    closeTimer();
    var overlay = el('div', 'timer-overlay');
    var panel = el('div', 'timer-panel');

    var label = el('div', 'timer-format', FP.formatLabel(block));
    var phase = el('div', 'timer-phase', '');
    var clock = el('div', 'timer-clock', '00:00');
    var sub = el('div', 'timer-sub', '');
    var controls = el('div', 'timer-controls');
    var startPause = el('button', 'btn primary', 'Start');
    var reset = el('button', 'btn', 'Reset');
    var close = el('button', 'btn ghost', 'Close');
    controls.appendChild(startPause);
    controls.appendChild(reset);
    controls.appendChild(close);

    panel.appendChild(label);
    panel.appendChild(phase);
    panel.appendChild(clock);
    panel.appendChild(sub);
    panel.appendChild(controls);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    var t = buildTimer(block, { clock: clock, phase: phase, sub: sub });
    timer = t;

    startPause.addEventListener('click', function () {
      if (t.running()) { t.pause(); startPause.textContent = 'Resume'; }
      else { t.start(); startPause.textContent = 'Pause'; }
    });
    reset.addEventListener('click', function () { t.reset(); startPause.textContent = 'Start'; });
    close.addEventListener('click', closeTimer);
    t.onDone = function () { startPause.textContent = 'Start'; };
    t.render();
  }

  function closeTimer() {
    if (timer) { timer.pause(); timer = null; }
    var o = document.querySelector('.timer-overlay');
    if (o) o.remove();
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function beep(times) {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = beep._ctx || (beep._ctx = new Ctx());
      var n = times || 1;
      for (var i = 0; i < n; i++) {
        var o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 880;
        o.connect(g); g.connect(ctx.destination);
        var at = ctx.currentTime + i * 0.18;
        g.gain.setValueAtTime(0.001, at);
        g.gain.exponentialRampToValueAtTime(0.3, at + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, at + 0.15);
        o.start(at); o.stop(at + 0.16);
      }
    } catch (e) { /* audio not available — timer still works visually */ }
  }

  function vibrate(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms); } catch (e) {} }
  }

  /**
   * Build a timer for a block. Modes:
   *   amrap    — countdown from minutes, beep at finish
   *   fortime  — count up (stopwatch)
   *   emom     — repeat 60s for `minutes` rounds, beep each minute top
   *   tabata   — rounds × (workSec work / restSec rest), phase display + beeps
   */
  function buildTimer(block, ui) {
    var running = false;
    var raf = null;
    var startedAt = 0;
    var elapsed = 0; // seconds accumulated while paused

    var total = null;    // total seconds for countdown modes
    var mode = block.format;
    if (mode === 'amrap') total = (block.minutes || 10) * 60;
    if (mode === 'emom') total = (block.minutes || 10) * 60;
    if (mode === 'tabata') total = (block.rounds || 8) * ((block.workSec || 20) + (block.restSec || 10));

    var lastMinute = -1;
    var lastPhase = '';

    function now() { return (Date.now() - startedAt) / 1000 + elapsed; }

    function render() {
      var t = running ? now() : elapsed;
      if (mode === 'fortime') {
        ui.clock.textContent = fmtClock(t);
        ui.phase.textContent = 'ELAPSED';
        ui.sub.textContent = block.rounds ? block.rounds + ' rounds for time' : 'Go as fast as you can';
        return;
      }
      var remaining = total - t;
      if (remaining <= 0) {
        ui.clock.textContent = '00:00';
        ui.phase.textContent = 'DONE';
        ui.sub.textContent = 'Nice work.';
        return;
      }
      if (mode === 'amrap') {
        ui.clock.textContent = fmtClock(remaining);
        ui.phase.textContent = 'AMRAP';
        ui.sub.textContent = 'Keep moving — as many rounds as possible';
      } else if (mode === 'emom') {
        var minIdx = Math.floor(t / 60);
        var intoMin = t - minIdx * 60;
        ui.clock.textContent = fmtClock(60 - intoMin);
        ui.phase.textContent = 'MINUTE ' + (minIdx + 1) + ' / ' + (block.minutes || '?');
        ui.sub.textContent = 'Start the work at the top of each minute';
      } else if (mode === 'tabata') {
        var cycle = (block.workSec || 20) + (block.restSec || 10);
        var roundIdx = Math.floor(t / cycle);
        var intoCycle = t - roundIdx * cycle;
        var work = block.workSec || 20;
        var inWork = intoCycle < work;
        ui.clock.textContent = fmtClock(inWork ? work - intoCycle : cycle - intoCycle);
        ui.phase.textContent = (inWork ? 'WORK' : 'REST') + ' · ' + (roundIdx + 1) + '/' + (block.rounds || 8);
        ui.sub.textContent = inWork ? 'Push!' : 'Breathe';
        ui.clock.style.color = inWork ? '#ffdd57' : '#6ee7ff';
      }
    }

    function cues() {
      var t = now();
      if (mode === 'emom') {
        var minIdx = Math.floor(t / 60);
        if (minIdx !== lastMinute && t < total) { lastMinute = minIdx; beep(1); vibrate(150); }
      } else if (mode === 'tabata') {
        var cycle = (block.workSec || 20) + (block.restSec || 10);
        var work = block.workSec || 20;
        var intoCycle = t - Math.floor(t / cycle) * cycle;
        var ph = intoCycle < work ? 'work' : 'rest';
        if (ph !== lastPhase && t < total) { lastPhase = ph; beep(ph === 'work' ? 2 : 1); vibrate(150); }
      }
      if (total != null && t >= total) { beep(3); vibrate([200, 100, 200]); stop(true); }
    }

    function loop() {
      if (!running) return;
      render();
      cues();
      raf = requestAnimationFrame(loop);
    }

    function start() {
      if (running) return;
      running = true;
      startedAt = Date.now();
      lastMinute = mode === 'emom' ? 0 : -1; // minute 1 cue already "spent" at t=0
      if (mode === 'tabata') { lastPhase = 'work'; beep(2); vibrate(150); }
      loop();
    }
    function pause() {
      if (!running) return;
      elapsed = now();
      running = false;
      if (raf) cancelAnimationFrame(raf);
    }
    function stop(done) {
      pause();
      if (done && ui) { elapsed = total || elapsed; render(); if (t2.onDone) t2.onDone(); }
    }
    function reset() {
      pause();
      elapsed = 0;
      lastMinute = -1; lastPhase = '';
      ui.clock.style.color = '';
      render();
    }

    var t2 = {
      start: start, pause: pause, reset: reset, render: render,
      running: function () { return running; }, onDone: null
    };
    return t2;
  }

  // ---------- helpers ----------
  function firstName(name) { return name ? name.split(/\s+/)[0] : 'there'; }
  function shortDay(label) {
    var m = String(label).match(/day\s*(\d+)/i);
    if (m) return 'Day ' + m[1];
    return String(label).length > 12 ? String(label).slice(0, 11) + '…' : label;
  }

  boot();
})();
