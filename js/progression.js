/*
 * progression.js — compares logged sessions against program targets and
 * suggests the next adjustment (double-progression style).
 *
 * Rules, applied per exercise from its most recent logged entry:
 *   - Missed reps or RPE well above target  -> hold or reduce load ~5%.
 *   - Hit top of rep range at/below target RPE -> add load (2.5% barbell-ish
 *     rounding) and reset to bottom of range.
 *   - Inside the rep range                  -> add a rep next time.
 *   - Fixed rep target hit                  -> small load increase.
 */
(function (global) {
  'use strict';

  function parseRepTarget(reps) {
    if (reps == null) return null;
    var s = String(reps).trim().toUpperCase();
    if (s === 'AMRAP') return { type: 'amrap' };
    var m = s.match(/^(\d+)\s*-\s*(\d+)/);
    if (m) return { type: 'range', low: parseInt(m[1], 10), high: parseInt(m[2], 10) };
    m = s.match(/^(\d+)/);
    if (m) return { type: 'fixed', reps: parseInt(m[1], 10) };
    return null;
  }

  function roundLoad(weight) {
    if (weight == null || isNaN(weight)) return null;
    // Round to nearest 2.5 (works for kg plates and most dumbbell racks).
    return Math.round(weight / 2.5) * 2.5;
  }

  /**
   * entry: { weight, setsDone, repsDone, rpe } — repsDone is the reps on the
   * last/hardest set. exercise: parsed exercise with sets/reps/rpe targets.
   * Returns { action, nextWeight, nextReps, reason }.
   */
  function suggest(exercise, entry) {
    var target = parseRepTarget(exercise.reps);
    var w = entry && entry.weight != null && entry.weight !== '' ? parseFloat(entry.weight) : null;
    var reps = entry && entry.repsDone != null && entry.repsDone !== '' ? parseInt(entry.repsDone, 10) : null;
    var rpe = entry && entry.rpe != null && entry.rpe !== '' ? parseFloat(entry.rpe) : null;
    var targetRpe = exercise.rpe != null ? exercise.rpe : null;

    if (!target || reps == null) {
      return { action: 'hold', nextWeight: w, nextReps: exercise.reps,
               reason: 'Not enough data logged — repeat the prescription.' };
    }

    var overRpe = targetRpe != null && rpe != null && rpe >= targetRpe + 1.5;

    if (target.type === 'range') {
      if (reps < target.low || overRpe) {
        var reduced = w != null ? roundLoad(w * 0.95) : null;
        return { action: 'reduce', nextWeight: reduced, nextReps: target.low + '-' + target.high,
                 reason: reps < target.low
                   ? 'Fell below the rep range — drop ~5% and rebuild.'
                   : 'RPE ran ' + (rpe - targetRpe).toFixed(1) + ' over target — take ~5% off.' };
      }
      if (reps >= target.high && (targetRpe == null || rpe == null || rpe <= targetRpe)) {
        var inc = w != null ? roundLoad(Math.max(w * 1.025, w + 2.5)) : null;
        return { action: 'increase', nextWeight: inc, nextReps: target.low + '-' + target.high,
                 reason: 'Topped the range at target effort — add load, restart at ' + target.low + ' reps.' };
      }
      return { action: 'add-rep', nextWeight: w, nextReps: target.low + '-' + target.high,
               reason: 'Inside the range — same load, chase ' + Math.min(reps + 1, target.high) + '+ reps.' };
    }

    if (target.type === 'fixed') {
      if (reps < target.reps || overRpe) {
        return { action: 'hold', nextWeight: w, nextReps: String(target.reps),
                 reason: 'Target not fully met — repeat the same load.' };
      }
      var inc2 = w != null ? roundLoad(Math.max(w * 1.025, w + 2.5)) : null;
      return { action: 'increase', nextWeight: inc2, nextReps: String(target.reps),
               reason: 'All reps at target effort — small load increase.' };
    }

    // AMRAP
    return { action: 'hold', nextWeight: w, nextReps: 'AMRAP',
             reason: reps != null ? 'Logged ' + reps + ' reps — beat it next time.' : 'Log reps to track the AMRAP.' };
  }

  /** Adherence: sessions logged vs expected over the last `days` days. */
  function adherence(sessions, daysPerWeek, days) {
    days = days || 14;
    var cutoff = Date.now() - days * 86400000;
    var recent = sessions.filter(function (s) {
      var t = Date.parse(s.date);
      return !isNaN(t) && t >= cutoff;
    });
    var expected = Math.max(1, Math.round((daysPerWeek || 3) * (days / 7)));
    return {
      done: recent.length,
      expected: expected,
      pct: Math.min(100, Math.round((recent.length / expected) * 100))
    };
  }

  global.FitProgression = {
    parseRepTarget: parseRepTarget,
    roundLoad: roundLoad,
    suggest: suggest,
    adherence: adherence
  };
})(typeof window !== 'undefined' ? window : this);
