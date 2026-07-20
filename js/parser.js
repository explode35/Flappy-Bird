/*
 * parser.js — turns raw coach programming text into a structured program.
 *
 * Output shape:
 * {
 *   name: string,
 *   weeks: number,
 *   clientHint: string|null,
 *   days: [{
 *     label: string,
 *     notes: [string],
 *     exercises: [{
 *       name: string,
 *       sets: number|null,
 *       reps: string|null,        // "8", "8-10", "AMRAP", "10/side"
 *       rpe: number|null,
 *       percent: number|null,     // %1RM
 *       restSeconds: number|null,
 *       tempo: string|null,       // e.g. "3010"
 *       superset: string|null,    // group key, e.g. "A"
 *       notes: [string],
 *       raw: string,
 *     }]
 *   }],
 *   warnings: [string],
 * }
 */
(function (global) {
  'use strict';

  var WEEKDAYS = [
    'monday', 'tuesday', 'wednesday', 'thursday',
    'friday', 'saturday', 'sunday'
  ];

  function parseRest(text) {
    // "rest 90s", "rest 2min", "rest 2 min", "rest 2-3min" (takes low end), "rest 1:30"
    var m = text.match(/rest[:\s]*(\d+):(\d{2})/i);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    m = text.match(/rest[:\s]*(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?\s*(s|sec|secs|seconds|m|min|mins|minutes)\b/i);
    if (!m) return null;
    var n = parseFloat(m[1]);
    var unit = m[2].toLowerCase();
    return unit.charAt(0) === 'm' ? Math.round(n * 60) : Math.round(n);
  }

  function formatRest(seconds) {
    if (seconds == null) return '';
    if (seconds % 60 === 0) return (seconds / 60) + ' min';
    if (seconds > 90 && seconds % 30 === 0) return (seconds / 60) + ' min';
    return seconds + 's';
  }

  function isDayHeader(line) {
    var l = line.trim();
    if (!l) return false;
    if (/^(day|week\s*\d+\s*day)\s*\d+/i.test(l)) return true;
    var firstWord = l.replace(/[:\-–].*$/, '').trim().toLowerCase();
    if (WEEKDAYS.indexOf(firstWord) !== -1) return true;
    if (/^#{1,4}\s+/.test(l)) return true;
    // "Upper A:", "Push:", "Lower body:" — short line ending with a colon,
    // with no set/rep scheme in it.
    if (/^[^:]{1,40}:$/.test(l) && !/\d\s*x\s*\d/i.test(l)) return true;
    return false;
  }

  function cleanDayLabel(line) {
    return line.trim()
      .replace(/^#{1,4}\s+/, '')
      .replace(/:$/, '')
      .trim();
  }

  function isNoteLine(line) {
    var l = line.trim();
    return /^[-*•>]\s+/.test(l) || /^notes?[:\s]/i.test(l);
  }

  function cleanNote(line) {
    return line.trim()
      .replace(/^[-*•>]\s+/, '')
      .replace(/^notes?[:\s]+/i, '')
      .trim();
  }

  // Matches a set/rep scheme: "4x8", "4 x 8-10", "3x10/side", "5xAMRAP", "4x8,8,6,6"
  var SCHEME_RE = /(\d+)\s*[x×]\s*(amrap|max|failure|\d+(?:\s*-\s*\d+)?(?:\s*\/\s*(?:side|leg|arm))?(?:\s*,\s*\d+)*)/i;

  function parseExercise(line) {
    var raw = line.trim();
    var work = raw;
    var ex = {
      name: '', sets: null, reps: null, rpe: null, percent: null,
      restSeconds: null, tempo: null, superset: null, notes: [], raw: raw
    };

    // Superset prefix: "A1." / "B2)" / "A1 -" / "ss:" — must be followed by
    // more content, so a bare header like "A1" isn't swallowed.
    var m = work.match(/^([A-H])(\d)\s*[.):\-]?\s+(.+)$/);
    if (m) {
      ex.superset = m[1].toUpperCase();
      work = m[3];
    } else {
      m = work.match(/^ss[.:\-]\s*(.+)$/i);
      if (m) { ex.superset = 'SS'; work = m[1]; }
    }

    var rest = parseRest(work);
    if (rest != null) {
      ex.restSeconds = rest;
      work = work.replace(/,?\s*rest[:\s]*[\d:.\-\s]+(?:s|sec|secs|seconds|m|min|mins|minutes)?\b\.?/i, ' ');
    }

    m = work.match(/tempo[:\s]*([0-9X]{3,4})/i);
    if (m) {
      ex.tempo = m[1].toUpperCase();
      work = work.replace(m[0], ' ');
    }

    // RPE: "@ RPE 7", "RPE7", "@7 RPE", "@ RPE 7-8" (low end kept as number)
    m = work.match(/@?\s*rpe[:\s]*(\d+(?:\.\d+)?)(?:\s*-\s*\d+(?:\.\d+)?)?/i);
    if (m) {
      ex.rpe = parseFloat(m[1]);
      work = work.replace(m[0], ' ');
    }

    // Percent of 1RM: "@ 75%", "75% 1RM", "@75%"
    m = work.match(/@?\s*(\d{2,3}(?:\.\d+)?)\s*%(?:\s*(?:of\s*)?1?rm)?/i);
    if (m) {
      ex.percent = parseFloat(m[1]);
      work = work.replace(m[0], ' ');
    }

    m = work.match(SCHEME_RE);
    if (m) {
      ex.sets = parseInt(m[1], 10);
      ex.reps = m[2].replace(/\s+/g, '').toUpperCase() === 'MAX'
        ? 'AMRAP'
        : m[2].replace(/\s+/g, '').toUpperCase() === 'FAILURE'
          ? 'AMRAP'
          : m[2].replace(/\s+/g, '');
      if (/^amrap$/i.test(ex.reps)) ex.reps = 'AMRAP';
      ex.name = work.slice(0, m.index).trim();
      var tail = work.slice(m.index + m[0].length).trim();
      tail = tail.replace(/^[@,\-–\s]+|[@,\-–\s]+$/g, '').trim();
      if (tail) ex.notes.push(tail);
    } else {
      // "Plank 3 sets 45s" / "Bike 10 min" — keep whole line as name, flag later
      ex.name = work.trim();
      m = work.match(/^(.*?)\s+(\d+)\s*sets?\s*(?:of\s*)?(.+)$/i);
      if (m) {
        ex.name = m[1].trim();
        ex.sets = parseInt(m[2], 10);
        ex.reps = m[3].trim();
      }
    }

    ex.name = ex.name
      .replace(/[\s,\-–:]+$/g, '')
      .replace(/^[\s,\-–:]+/g, '')
      .replace(/\s{2,}/g, ' ');
    return ex;
  }

  function looksLikeExercise(line) {
    var l = line.trim();
    if (!l) return false;
    if (SCHEME_RE.test(l)) return true;
    if (/\d+\s*sets?\b/i.test(l)) return true;
    if (/\b\d+\s*(min|mins|minutes|s|sec|secs|seconds)\b/i.test(l) && !isNoteLine(l)) return true;
    return false;
  }

  function parseProgram(text) {
    var program = {
      name: 'Untitled Program',
      weeks: 4,
      clientHint: null,
      days: [],
      warnings: []
    };
    if (!text || !text.trim()) {
      program.warnings.push('No text to parse.');
      return program;
    }

    var lines = text.replace(/\r\n?/g, '\n').split('\n');
    var currentDay = null;
    var lastExercise = null;

    function ensureDay(label) {
      currentDay = { label: label, notes: [], exercises: [] };
      program.days.push(currentDay);
      lastExercise = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var l = line.trim();
      if (!l) continue;

      var m = l.match(/^program[:\s]+(.+)$/i);
      if (m) { program.name = m[1].trim(); continue; }
      m = l.match(/^client[:\s]+(.+)$/i);
      if (m) { program.clientHint = m[1].trim(); continue; }
      m = l.match(/^weeks?[:\s]+(\d+)/i);
      if (m) { program.weeks = parseInt(m[1], 10); continue; }
      m = l.match(/\((\d+)\s*weeks?\)/i);
      if (m && !currentDay) {
        program.weeks = parseInt(m[1], 10);
        var stripped = l.replace(m[0], '').trim();
        if (stripped && program.name === 'Untitled Program') program.name = stripped;
        continue;
      }

      if (isDayHeader(l) && !looksLikeExercise(l)) {
        ensureDay(cleanDayLabel(l));
        continue;
      }

      if (isNoteLine(l)) {
        var note = cleanNote(l);
        if (!note) continue;
        if (lastExercise) lastExercise.notes.push(note);
        else if (currentDay) currentDay.notes.push(note);
        else program.warnings.push('Note before any day, ignored: "' + note + '"');
        continue;
      }

      if (looksLikeExercise(l)) {
        if (!currentDay) ensureDay('Day 1');
        var ex = parseExercise(l);
        if (!ex.name) {
          program.warnings.push('Could not read exercise name on line ' + (i + 1) + ': "' + l + '"');
          ex.name = 'Unnamed exercise';
        }
        currentDay.exercises.push(ex);
        lastExercise = ex;
        continue;
      }

      // A short bare line with no scheme: treat as a day header if nothing is
      // open yet, otherwise as a note on the current day.
      if (!currentDay) {
        if (program.name === 'Untitled Program') { program.name = l; }
        else ensureDay(l);
      } else if (l.length <= 30 && currentDay.exercises.length > 0) {
        ensureDay(l);
      } else {
        currentDay.notes.push(l);
      }
    }

    if (program.days.length === 0) {
      program.warnings.push('No training days found — check the day headers.');
    }
    program.days.forEach(function (d) {
      if (d.exercises.length === 0) {
        program.warnings.push('Day "' + d.label + '" has no exercises.');
      }
    });
    return program;
  }

  function schemeLabel(ex) {
    var parts = [];
    if (ex.sets != null && ex.reps != null) parts.push(ex.sets + ' × ' + ex.reps);
    else if (ex.reps != null) parts.push(ex.reps);
    if (ex.percent != null) parts.push('@ ' + ex.percent + '%');
    if (ex.rpe != null) parts.push('RPE ' + ex.rpe);
    if (ex.tempo) parts.push('tempo ' + ex.tempo);
    if (ex.restSeconds != null) parts.push('rest ' + formatRest(ex.restSeconds));
    return parts.join(' · ');
  }

  global.FitParser = {
    parseProgram: parseProgram,
    parseExercise: parseExercise,
    parseRest: parseRest,
    formatRest: formatRest,
    schemeLabel: schemeLabel
  };
})(typeof window !== 'undefined' ? window : this);
