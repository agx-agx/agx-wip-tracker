'use strict';
// What "unknown" looks like in a Buildertrend-shaped cell: empty, a dash, or
// a placeholder word. Requires nothing and does no I/O.

const BLANK_WORDS = new Set(['n/a', 'unassigned', 'tbd']);

// BLANK on the Buildertrend side: unknown, never a value.
function isBtBlank(v) {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'number') return false;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return true;
  if (/^[-–—]+$/.test(s)) return true;
  return BLANK_WORDS.has(s.toLowerCase());
}

module.exports = { isBtBlank };
