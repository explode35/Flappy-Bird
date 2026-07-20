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
 *     blocks: [{
 *       format: 'standard'|'amrap'|'emom'|'tabata'|'fortime'|'circuit',
 *       label: string,            // section title ("Strength") or raw header
 *       minutes: number|null,     // amrap/emom cap
 *       rounds: number|null,      // tabata/fortime/circuit
 *       workSec: number|null,     // tabata
 *       restSec: number|null,     // tabata
 *       notes: [string],
 *       exercises: [{
 *         name, sets, reps, rpe, percent, restSeconds, tempo, superset,
 *         notes: [string], raw
 *       }]
 *     }]
 *   }],
 *   warnings: [string],
 * }
 *
 * The workout style is explicit per block, so the client-facing views can
 * say "AMRAP · 12 MIN" or "TABATA · 8 × 20s/10s" before anyone hits start.
 */
(function (global) {
  'use strict';

  var WEEKDAYS = [
    'monday', 'tuesday', 'wednesday', 'thursday',
    'friday', 'saturday', 'sunday'
  ];

  // Section titles that mean "new block in the same day", not "new day".
  var SECTION_RE = /^(warm[\s-]?up|cool[\s-]?down|strength|conditioning|metcon|accessor(?:y|ies)|core|finisher|cardio|mobility|skill|power)$/i;

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

  // ---------- workout-format blocks ----------
  function newBlock(format, props) {
    var b = {
      format: format, label: '', minutes: null, rounds: null,
      workSec: null, restSec: null, notes: [], exercises: []
    };
    Object.keys(props || {}).forEach(function (k) { b[k] = props[k]; });
    return b;
  }

  /** The core format matchers, run on a cleaned string. Returns a block or null. */
  function matchFormat(l) {
    var m;

    m = l.match(/^amrap\s*[-–·]?\s*(\d+)?\s*(?:min(?:ute)?s?)?$/i) ||
        l.match(/^(\d+)\s*min(?:ute)?s?\s*amrap$/i);
    if (m) return newBlock('amrap', { minutes: m[1] ? parseInt(m[1], 10) : null, label: l });

    m = l.match(/^tabata(?:\s*[-–·]?\s*(\d+)\s*(?:rounds?|x))?(?:\s*(?:of)?\s*(\d+)\s*[\/-]\s*(\d+)\s*s?(?:ec)?)?$/i);
    if (m) {
      return newBlock('tabata', {
        rounds: m[1] ? parseInt(m[1], 10) : 8,
        workSec: m[2] ? parseInt(m[2], 10) : 20,
        restSec: m[3] ? parseInt(m[3], 10) : 10,
        label: l
      });
    }

    m = l.match(/^emom\s*[-–·]?\s*(\d+)\s*(?:min(?:ute)?s?)?$/i) ||
        l.match(/^every minute on the minute(?:\s*(?:for)?\s*(\d+)\s*min(?:ute)?s?)?$/i);
    if (m) return newBlock('emom', { minutes: m[1] ? parseInt(m[1], 10) : null, label: l });

    m = l.match(/^(?:(\d+)\s*rounds?\s*[-–·,]?\s*)?for time$/i);
    if (m) return newBlock('fortime', { rounds: m[1] ? parseInt(m[1], 10) : null, label: l });

    m = l.match(/^circuit\s*[x×]?\s*(\d+)?\s*(?:rounds?)?$/i) ||
        l.match(/^(\d+)\s*rounds?\s*circuit$/i);
    if (m) return newBlock('circuit', { rounds: m[1] ? parseInt(m[1], 10) : null, label: l });

    return null;
  }

  /**
   * Recognise a workout-format header line; returns a block or null. Also
   * handles a leading section prefix, e.g. "Finisher - 3 Rounds For Time" or
   * "Metcon: AMRAP 12", keeping the prefix as the block's section label.
   */
  function parseBlockHeader(line) {
    var l = line.trim().replace(/:$/, '').trim();
    if (!l || l.length > 60) return null;

    var block = matchFormat(l);
    if (block) return block;

    // Try stripping a leading "Section - " / "Section: " prefix.
    var m = l.match(/^(.{1,24}?)\s*[-–:]\s*(.+)$/);
    if (m) {
      var inner = matchFormat(m[2].trim());
      if (inner) {
        inner.label = m[1].trim() + ' · ' + inner.label;
        return inner;
      }
    }
    return null;
  }

  function formatLabel(block) {
    switch (block.format) {
      case 'amrap': return 'AMRAP' + (block.minutes ? ' · ' + block.minutes + ' MIN' : '');
      case 'emom': return 'EMOM' + (block.minutes ? ' · ' + block.minutes + ' MIN' : '');
      case 'tabata': return 'TABATA · ' + block.rounds + ' × ' + block.workSec + 's/' + block.restSec + 's';
      case 'fortime': return (block.rounds ? block.rounds + ' ROUNDS ' : '') + 'FOR TIME';
      case 'circuit': return 'CIRCUIT' + (block.rounds ? ' · ' + block.rounds + ' ROUNDS' : '');
      default: return 'STANDARD SETS';
    }
  }

  function formatExplainer(block) {
    switch (block.format) {
      case 'amrap':
        return 'As many rounds of this list as possible' +
          (block.minutes ? ' in ' + block.minutes + ' minutes' : '') + '. Rest only as needed.';
      case 'emom':
        return 'Every minute on the minute' + (block.minutes ? ' for ' + block.minutes + ' minutes' : '') +
          ': start the work at the top of each minute, rest whatever is left.';
      case 'tabata':
        return block.workSec + ' seconds all-out, ' + block.restSec + ' seconds off — ' +
          block.rounds + ' times through.';
      case 'fortime':
        return 'Complete ' + (block.rounds ? 'all ' + block.rounds + ' rounds' : 'the work') +
          ' as fast as possible with good form. Note your time.';
      case 'circuit':
        return 'Go through the exercises in order' +
          (block.rounds ? ', ' + block.rounds + ' rounds total' : '') + ', minimal rest between moves.';
      default:
        return 'Finish all sets of each exercise before moving to the next.';
    }
  }

  // ---------- day / note / exercise line classification ----------
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
      var repsTok = m[2].replace(/\s+/g, '').toUpperCase();
      ex.reps = (repsTok === 'MAX' || repsTok === 'FAILURE' || repsTok === 'AMRAP')
        ? 'AMRAP'
        : m[2].replace(/\s+/g, '');
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

  /**
   * Exercise lines inside AMRAP/EMOM/tabata/etc. blocks are usually written
   * reps-first: "10 Kettlebell Swings", "15 cal Row", "Max Burpees",
   * "Even: 12 Wall Balls". Falls back to parseExercise for "3x10" style.
   */
  function parseFormatExercise(line) {
    var raw = line.trim();
    if (SCHEME_RE.test(raw)) return parseExercise(raw);

    var ex = {
      name: '', sets: null, reps: null, rpe: null, percent: null,
      restSeconds: null, tempo: null, superset: null, notes: [], raw: raw
    };
    var work = raw;
    var tag = null;

    // EMOM minute tags: "Odd: ..." / "Even: ..." / "Min 3: ..."
    var m = work.match(/^((?:odd|even)(?:\s*min(?:ute)?s?)?|min(?:ute)?\s*\d+)[.:\-\s]+\s*(.+)$/i);
    if (m) {
      tag = m[1].replace(/\s+/g, ' ').trim();
      tag = tag.charAt(0).toUpperCase() + tag.slice(1).toLowerCase();
      work = m[2];
    }

    m = work.match(/^max\s+(.+)$/i);
    if (m) {
      ex.reps = 'AMRAP';
      ex.name = m[1].trim();
    } else if ((m = work.match(/^(\d+)\s*cal(?:s|ories)?\s+(.+)$/i))) {
      ex.reps = m[1] + ' cal';
      ex.name = m[2].trim();
    } else if ((m = work.match(/^(\d+(?:\s*\/\s*(?:side|leg|arm))?)\s+(.+)$/))) {
      ex.reps = m[1].replace(/\s+/g, '');
      ex.name = m[2].trim();
    } else {
      ex.name = work.trim();
    }

    if (tag) ex.name = tag + ': ' + ex.name;
    ex.name = ex.name.replace(/[\s,\-–:]+$/g, '').replace(/\s{2,}/g, ' ');
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

  // ---------- the main parse ----------
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
    var currentBlock = null;
    var lastExercise = null;

    function ensureDay(label) {
      currentDay = { label: label, notes: [], blocks: [] };
      program.days.push(currentDay);
      currentBlock = null;
      lastExercise = null;
    }
    function ensureBlock() {
      if (!currentDay) ensureDay('Day 1');
      if (!currentBlock) {
        currentBlock = newBlock('standard');
        currentDay.blocks.push(currentBlock);
      }
      return currentBlock;
    }
    function pushBlock(block) {
      if (!currentDay) ensureDay('Day 1');
      currentDay.blocks.push(block);
      currentBlock = block;
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

      // Workout-format headers ("AMRAP 12 min:", "Tabata", "EMOM 10") come
      // before day-header detection — the colon rule would otherwise eat them.
      var block = parseBlockHeader(l);
      if (block) { pushBlock(block); continue; }

      // Section titles ("Strength:", "Conditioning:") inside an open day are
      // new standard blocks, not new days.
      var sectionLabel = cleanDayLabel(l);
      if (currentDay && /:$/.test(l) && SECTION_RE.test(sectionLabel)) {
        pushBlock(newBlock('standard', { label: sectionLabel }));
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
        else if (currentBlock) currentBlock.notes.push(note);
        else if (currentDay) currentDay.notes.push(note);
        else program.warnings.push('Note before any day, ignored: "' + note + '"');
        continue;
      }

      // Inside a format block, every remaining line is an exercise
      // (reps-first style like "10 Burpees" has no set/rep scheme).
      if (currentBlock && currentBlock.format !== 'standard') {
        var fx = parseFormatExercise(l);
        currentBlock.exercises.push(fx);
        lastExercise = fx;
        continue;
      }

      if (looksLikeExercise(l)) {
        var ex = parseExercise(l);
        if (!ex.name) {
          program.warnings.push('Could not read exercise name on line ' + (i + 1) + ': "' + l + '"');
          ex.name = 'Unnamed exercise';
        }
        ensureBlock().exercises.push(ex);
        lastExercise = ex;
        continue;
      }

      // A short bare line with no scheme: treat as a day header if nothing is
      // open yet, otherwise as a note on the current day.
      if (!currentDay) {
        if (program.name === 'Untitled Program') { program.name = l; }
        else ensureDay(l);
      } else if (l.length <= 30 && dayExerciseCount(currentDay) > 0) {
        ensureDay(l);
      } else {
        currentDay.notes.push(l);
      }
    }

    if (program.days.length === 0) {
      program.warnings.push('No training days found — check the day headers.');
    }
    program.days.forEach(function (d) {
      if (dayExerciseCount(d) === 0) {
        program.warnings.push('Day "' + d.label + '" has no exercises.');
      }
    });
    return program;
  }

  function dayExerciseCount(day) {
    return (day.blocks || []).reduce(function (n, b) { return n + b.exercises.length; }, 0);
  }

  /** Flatten a day's blocks into [{exercise, block}] for logging grids etc. */
  function flatExercises(day) {
    var out = [];
    (day.blocks || []).forEach(function (b) {
      b.exercises.forEach(function (ex) { out.push({ exercise: ex, block: b }); });
    });
    return out;
  }

  /** Wrap legacy {exercises: []} days (pre-blocks data) into a standard block. */
  function migrateDays(days) {
    (days || []).forEach(function (d) {
      if (!d.blocks) {
        d.blocks = [newBlock('standard')];
        d.blocks[0].exercises = d.exercises || [];
        delete d.exercises;
      }
    });
    return days;
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
    parseFormatExercise: parseFormatExercise,
    parseBlockHeader: parseBlockHeader,
    parseRest: parseRest,
    formatRest: formatRest,
    schemeLabel: schemeLabel,
    formatLabel: formatLabel,
    formatExplainer: formatExplainer,
    flatExercises: flatExercises,
    migrateDays: migrateDays,
    dayExerciseCount: dayExerciseCount
  };
})(typeof window !== 'undefined' ? window : this);
