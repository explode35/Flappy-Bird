/*
 * deliver.js — generates the client-facing deliverables:
 *   - printable program sheet (opens in a new window, ready for print/PDF)
 *   - weekly check-in form (printable)
 *   - copy-paste check-in message
 *   - CSV export of a program
 */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  var SHEET_CSS = [
    'body{font-family:Georgia,"Times New Roman",serif;color:#1c2430;margin:40px auto;max-width:760px;padding:0 24px;line-height:1.5}',
    '.brand{font-family:Helvetica,Arial,sans-serif;text-transform:uppercase;letter-spacing:.18em;font-size:11px;color:#8a94a6}',
    'h1{font-size:26px;margin:6px 0 2px}',
    '.meta{color:#5b6472;font-size:14px;margin-bottom:24px}',
    'h2{font-family:Helvetica,Arial,sans-serif;font-size:15px;text-transform:uppercase;letter-spacing:.08em;border-bottom:2px solid #1c2430;padding-bottom:6px;margin:28px 0 10px}',
    'table{width:100%;border-collapse:collapse;font-size:14px}',
    'th{font-family:Helvetica,Arial,sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:.06em;text-align:left;color:#5b6472;padding:6px 8px;border-bottom:1px solid #d6dbe3}',
    'td{padding:8px;border-bottom:1px solid #edf0f4;vertical-align:top}',
    '.ss{font-family:Helvetica,Arial,sans-serif;font-size:11px;font-weight:bold;color:#8a94a6}',
    '.note{color:#5b6472;font-size:12.5px;font-style:italic}',
    '.daynote{color:#5b6472;font-size:13px;font-style:italic;margin:4px 0 8px}',
    '.log td{height:26px;border-bottom:1px dotted #c3cad4}',
    '.foot{margin-top:36px;color:#8a94a6;font-size:12px;border-top:1px solid #edf0f4;padding-top:12px}',
    '.field{margin:14px 0}.field label{display:block;font-family:Helvetica,Arial,sans-serif;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#5b6472;margin-bottom:4px}',
    '.line{border-bottom:1px solid #c3cad4;height:24px}.box{border:1px solid #c3cad4;height:90px;border-radius:4px}',
    '.scale{display:flex;gap:14px;font-size:14px}.scale span{border:1px solid #c3cad4;border-radius:50%;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center}',
    '@media print{body{margin:0 auto}}'
  ].join('\n');

  function openSheet(title, bodyHtml) {
    var html = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) +
      '</title><style>' + SHEET_CSS + '</style></head><body>' + bodyHtml +
      '</body></html>';
    var w = global.open('', '_blank');
    if (!w) return null;
    w.document.open();
    w.document.write(html);
    w.document.close();
    return w;
  }

  function programSheet(program, client, coachName) {
    var h = '<div class="brand">' + esc(coachName || 'Coaching') + ' · Training Program</div>';
    h += '<h1>' + esc(program.name) + '</h1>';
    h += '<div class="meta">' + (client ? 'Prepared for <strong>' + esc(client.name) + '</strong> · ' : '') +
      esc(program.weeks) + '-week block · ' + program.days.length + ' training days/week</div>';

    program.days.forEach(function (day) {
      h += '<h2>' + esc(day.label) + '</h2>';
      day.notes.forEach(function (n) { h += '<div class="daynote">' + esc(n) + '</div>'; });
      h += '<table><thead><tr><th style="width:42%">Exercise</th><th>Prescription</th><th style="width:22%">Notes</th></tr></thead><tbody>';
      day.exercises.forEach(function (ex, i) {
        var label = global.FitParser.schemeLabel(ex);
        var ssTag = ex.superset ? '<span class="ss">' + esc(ex.superset) + (countInGroup(day, ex, i)) + '&nbsp;</span>' : '';
        h += '<tr><td>' + ssTag + esc(ex.name) + '</td><td>' + esc(label || '—') + '</td><td class="note">' +
          esc(ex.notes.join(' · ')) + '</td></tr>';
      });
      h += '</tbody></table>';
    });

    h += '<h2>Session Log</h2><table class="log"><thead><tr><th>Date</th><th>Day</th><th>Top sets / weights</th><th>How it felt</th></tr></thead><tbody>';
    for (var r = 0; r < 8; r++) h += '<tr><td></td><td></td><td></td><td></td></tr>';
    h += '</tbody></table>';
    h += '<div class="foot">Questions mid-week? Message me any time — don’t wait for check-in day. ' +
      'Log your top sets after each session so we can progress you accurately.</div>';
    return openSheet(program.name + (client ? ' — ' + client.name : ''), h);
  }

  function countInGroup(day, ex, index) {
    // Position of this exercise inside its superset group, for "A1"/"A2" labels.
    var n = 0;
    for (var i = 0; i <= index; i++) {
      if (day.exercises[i].superset === ex.superset) n++;
    }
    return n;
  }

  function checkinForm(client, coachName) {
    var h = '<div class="brand">' + esc(coachName || 'Coaching') + ' · Weekly Check-in</div>';
    h += '<h1>Weekly Check-in</h1>';
    h += '<div class="meta">' + (client ? esc(client.name) + ' · ' : '') + 'Week of ____________</div>';
    h += '<div class="field"><label>Body weight (morning, after bathroom)</label><div class="line"></div></div>';
    h += '<div class="field"><label>Sessions completed this week</label><div class="scale"><span>0</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span></div></div>';
    h += '<div class="field"><label>Average sleep (hours/night)</label><div class="line"></div></div>';
    h += '<div class="field"><label>Stress level (1 = calm, 5 = maxed out)</label><div class="scale"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div></div>';
    h += '<div class="field"><label>Nutrition adherence (1 = off plan, 5 = dialed in)</label><div class="scale"><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span></div></div>';
    h += '<div class="field"><label>Biggest win this week</label><div class="box"></div></div>';
    h += '<div class="field"><label>Biggest struggle / anything hurting?</label><div class="box"></div></div>';
    h += '<div class="field"><label>Questions for me</label><div class="box"></div></div>';
    h += '<div class="foot">Send this back by ' + esc(client && client.checkinDay ? client.checkinDay : 'Sunday') +
      ' evening. Honest answers beat perfect answers.</div>';
    return openSheet('Check-in — ' + (client ? client.name : ''), h);
  }

  function checkinMessage(client) {
    var first = client && client.name ? client.name.split(/\s+/)[0] : 'there';
    return 'Hey ' + first + '! Check-in time — reply with:\n' +
      '1. Morning body weight\n' +
      '2. Sessions completed this week\n' +
      '3. Avg sleep (hrs) + stress (1–5)\n' +
      '4. Nutrition adherence (1–5)\n' +
      '5. Biggest win + biggest struggle\n\n' +
      'Two-line answers are fine. I’ll review tonight and adjust next week’s plan.';
  }

  function welcomeMessage(client, program) {
    var first = client && client.name ? client.name.split(/\s+/)[0] : 'there';
    return 'Welcome aboard, ' + first + '!\n\n' +
      'Your program “' + (program ? program.name : 'Block 1') + '” is attached — ' +
      (program ? program.days.length : 3) + ' sessions a week for ' + (program ? program.weeks : 4) + ' weeks.\n\n' +
      'How this works:\n' +
      '• Follow the sheet in order; rest times and effort targets are on it.\n' +
      '• Log your top sets after each session.\n' +
      '• Check-ins land every ' + (client && client.checkinDay ? client.checkinDay : 'Sunday') + ' — short and honest.\n' +
      '• Anything hurts or doesn’t make sense, message me straight away.\n\n' +
      'First session: just move well and find your working weights. We build from there.';
  }

  function programCSV(program) {
    var rows = [['Day', 'Order', 'Superset', 'Exercise', 'Sets', 'Reps', 'RPE', '%1RM', 'Rest (s)', 'Tempo', 'Notes']];
    program.days.forEach(function (day) {
      day.exercises.forEach(function (ex, i) {
        rows.push([day.label, i + 1, ex.superset || '', ex.name,
          ex.sets != null ? ex.sets : '', ex.reps != null ? ex.reps : '',
          ex.rpe != null ? ex.rpe : '', ex.percent != null ? ex.percent : '',
          ex.restSeconds != null ? ex.restSeconds : '', ex.tempo || '',
          ex.notes.join('; ')]);
      });
    });
    return rows.map(function (r) {
      return r.map(function (cell) {
        var s = String(cell);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      }).join(',');
    }).join('\n');
  }

  function download(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  global.FitDeliver = {
    programSheet: programSheet,
    checkinForm: checkinForm,
    checkinMessage: checkinMessage,
    welcomeMessage: welcomeMessage,
    programCSV: programCSV,
    download: download
  };
})(typeof window !== 'undefined' ? window : this);
