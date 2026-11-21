'use strict';

/**
 * archive-common.js — the things export-all-data.js and restore-all-data.js
 * must agree on, kept in one place so they cannot drift apart.
 *
 * Pure functions only. Nothing here opens a connection; the two scripts own
 * their own clients. That is also what makes this file unit-testable without
 * a database (test/archive-common.test.js).
 *
 * ARCHIVE FORMATS
 *   1  — what the first export (4196e2a3, used for the 7 Oct 2026 archive)
 *        wrote. No "format" key in _manifest.json. Rows were paged with
 *        ORDER BY 1 LIMIT/OFFSET outside any transaction, and DATE /
 *        TIMESTAMPTZ values went through JavaScript Date objects. See
 *        legacyDateValue() for what that did to dates.
 *   2  — this version. One REPEATABLE READ snapshot, a server-side cursor
 *        per table, date/time values kept as Postgres's own text, a checksum
 *        per table and the sequence positions, all in the manifest.
 */

const fs = require('fs');

const FORMAT = 2;
const CHECKSUM_ALGO = 'md5-sorted-rowmd5-v2';

/* Identifiers come from the catalogue, but quote them anyway rather than
 * trusting that forever. */
function q(ident) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) throw new Error('refusing identifier: ' + ident);
  return '"' + ident + '"';
}

/* Applied, in this order, inside every transaction that writes or reads
 * archive values — export, restore load and restore verify. The checksum is
 * computed from Postgres's text output of each row, and that text depends on
 * all four of these: a timestamptz prints in the session's time zone, and a
 * float prints with extra_float_digits. Same settings on both sides, same
 * text, same checksum. */
const SESSION_SETTINGS = [
  "SET LOCAL TIME ZONE 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  'SET LOCAL extra_float_digits = 3',
];

/* node-postgres turns DATE, TIMESTAMP and TIMESTAMPTZ into JavaScript Date
 * objects by default. A Date has millisecond precision (Postgres keeps
 * microseconds) and a DATE becomes local midnight on whatever machine ran the
 * export, which JSON then prints in UTC. The export keeps these as the text
 * Postgres sent instead, which loads back exactly. */
const KEEP_AS_TEXT_OIDS = new Set([
  1082, 1083, 1114, 1184, 1186, 1266,   // date, time, timestamp, timestamptz, interval, timetz
  1182, 1183, 1115, 1185, 1187, 1270,   // ...and their array types
  114, 3802, 199, 3807,                 // json, jsonb, and their array types — see JSON_OIDS
  700, 701, 1021, 1022,                 // real, double and their arrays: NaN, ±Infinity and -0 have no JSON number
  1231,                                 // numeric[]: node-postgres parses it to JS numbers (12.50 -> 12.5)
]);

/* JSONB columns, which the export writes into each JSONL line VERBATIM, as
 * the JSON text Postgres printed, instead of as a parsed value.
 *
 * node-postgres parses jsonb with JavaScript's JSON.parse, and that rewrites
 * numbers: 3.0 comes back as 3, 12.50 as 12.5, and an integer past 2^53 is
 * silently rounded. P86 keeps money in JSONB blobs (jobs.data, estimates,
 * POs), so a backup that went through JSON.parse is not the data that was
 * there — found by the round-trip checksum, which refused to match. Postgres's
 * jsonb text is valid JSON with no raw line breaks, so it can sit inside the
 * line unchanged, and the restore hands the lines to Postgres to parse
 * instead of to JavaScript.
 *
 * Plain json (OID 114) is NOT spliced: json keeps its input byte-for-byte,
 * raw newlines included, which would break one-row-per-line. It is kept as
 * text and written as a JSON string; the restore casts it back with ::json.
 *
 * An SQL NULL in a jsonb column is written by LEAVING THE KEY OUT, so it
 * cannot be confused with the JSON value null (which is spliced as `null`).
 * The restore reads jsonb columns with x.r -> 'col', where a missing key is
 * SQL NULL and `null` is 'null'::jsonb. */
const JSON_OIDS = new Set([3802]);

function textDateTypes(pgTypes) {
  return {
    getTypeParser(oid, format) {
      if (KEEP_AS_TEXT_OIDS.has(oid)) return (v) => v;
      return pgTypes.getTypeParser(oid, format);
    },
  };
}

/* The checksum of one table: md5 over every row's text, rows sorted, with the
 * columns in NAME order rather than position order. A database built fresh by
 * initSchema has a table's columns in CREATE TABLE order; production has the
 * ones added later by ALTER TABLE ... ADD COLUMN at the end. Same data, two
 * column orders, and ROW(*)::text would differ. Naming the columns sorted
 * removes that.
 *
 * COLLATE "C" for the same reason: the sort must not depend on the database's
 * locale, and a scratch database on Windows and Railway's Postgres do not
 * share one.
 *
 * Each row is hashed first and only the 32-character hashes are aggregated,
 * so the one string Postgres builds grows by 32 bytes a row, not by the row's
 * whole text — a text value is capped at 1 GiB, and a large jsonb table would
 * have hit that and killed the export before the manifest was written. */
function checksumSql(table, columns) {
  if (!columns || !columns.length) throw new Error('checksumSql: ' + table + ' has no columns');
  const cols = columns.slice().sort();
  const row = 'ROW(' + cols.map((c) => 't.' + q(c)).join(', ') + ')::text';
  return 'SELECT COUNT(*)::bigint AS n, '
    + "md5(COALESCE(string_agg(h, '' ORDER BY h COLLATE \"C\"), '')) AS sum "
    + 'FROM (SELECT md5(' + row + ') AS h FROM ' + q(table) + ' t) s';
}

/* JSON.stringify replacer for export rows: a bytea arrives as a Buffer.
 *
 * The format-1 export tested Buffer.isBuffer(v) in its replacer, which never
 * matched: JSON.stringify calls Buffer's toJSON() BEFORE the replacer sees the
 * value, so what arrives is { type: 'Buffer', data: [...] }. No column in the
 * schema is bytea today, so nothing was lost — but the encoding it promised
 * never ran. This checks for the shape the replacer actually receives. */
function encodeValue(key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
    return { __bytea: Buffer.from(value.data).toString('base64') };
  }
  return value;
}

/* One JSONL line. rawJson names the jsonb columns whose value is already JSON
 * text from Postgres (see JSON_OIDS): spliced in as they are, and left out
 * entirely when the column is SQL NULL.
 *
 * U+2028 and U+2029 are escaped on the way out. JSON allows them raw inside
 * strings and neither JSON.stringify nor Postgres escapes them, but Node's
 * readline — and plenty of other line readers — treat them as line breaks,
 * so one pasted-from-Word paragraph separator would split a row in two. In
 * valid JSON they can only occur inside strings, where U+2028 means the same
 * character, so the escape changes nothing a JSON parser reads. */
const LINE_SEP = new RegExp(String.fromCharCode(0x2028), 'g');
const PARA_SEP = new RegExp(String.fromCharCode(0x2029), 'g');

function encodeRow(row, rawJson) {
  let line;
  if (!rawJson || !rawJson.size) {
    line = JSON.stringify(row, encodeValue);
  } else {
    const parts = [];
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (rawJson.has(k)) {
        if (v === null) continue;
        parts.push(JSON.stringify(k) + ':' + v);
      } else {
        parts.push(JSON.stringify(k) + ':' + JSON.stringify(v, encodeValue));
      }
    }
    line = '{' + parts.join(',') + '}';
  }
  return line.replace(LINE_SEP, '\\u2028').replace(PARA_SEP, '\\u2029');
}

/* The lines of a JSONL file, split on '\n' ONLY (a trailing '\r' is
 * dropped). Not readline: readline also breaks on U+2028/U+2029, which an
 * archive written before encodeRow escaped them — the 7 Oct one — can hold
 * raw inside its strings. */
async function* jsonlLines(file) {
  let buf = '';
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8' })) {
    buf += chunk;
    let start = 0;
    let i;
    while ((i = buf.indexOf('\n', start)) !== -1) {
      const line = buf.slice(start, i);
      yield line.endsWith('\r') ? line.slice(0, -1) : line;
      start = i + 1;
    }
    buf = buf.slice(start);
  }
  if (buf) yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
}

/* A format-1 DATE value is local midnight on the exporting machine, printed
 * in UTC: '2026-10-07' exported on a machine at UTC-4 reads
 * '2026-10-07T04:00:00.000Z', and at UTC+2 it reads '2026-10-06T22:00:00.000Z'.
 * Taking the date part is right west of Greenwich and a day early east of it.
 * Rounding to the NEAREST UTC midnight is right for every offset strictly
 * between -12h and +12h, which covers every place this export has been run. */
function legacyDateValue(v) {
  if (typeof v !== 'string') return v;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return v;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) return v;
  const DAY = 86400000;
  return new Date(Math.round(ms / DAY) * DAY).toISOString().slice(0, 10);
}

/* Both spellings: { __bytea } from this version, and the raw
 * { type: 'Buffer', data } a format-1 export wrote (see encodeValue). */
function decodeBytea(v) {
  if (v && typeof v === 'object' && typeof v.__bytea === 'string') {
    return '\\x' + Buffer.from(v.__bytea, 'base64').toString('hex');
  }
  if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) {
    return '\\x' + Buffer.from(v.data).toString('hex');
  }
  return v;
}

/* Turn one exported row back into what jsonb_populate_recordset will accept.
 * Only columns the TARGET says are bytea / date are touched, so a jsonb
 * column that happens to contain a key called __bytea is left alone.
 *
 *   colTypes  — { column: { base: 'bytea'|'date'|..., isArray: bool } }
 *   legacy    — true for a format-1 archive */
function decodeRow(row, colTypes, legacy) {
  const out = {};
  for (const k of Object.keys(row)) {
    let v = row[k];
    const t = colTypes[k];
    if (t && v != null) {
      if (t.base === 'bytea') v = t.isArray && Array.isArray(v) ? v.map(decodeBytea) : decodeBytea(v);
      else if (legacy && t.base === 'date') v = t.isArray && Array.isArray(v) ? v.map(legacyDateValue) : legacyDateValue(v);
    }
    out[k] = v;
  }
  return out;
}

/* Host, port and database name — the three things that decide which database
 * a URL reaches. Parsed by pg-connection-string, the parser node-postgres
 * itself uses, so a ?host= parameter, percent-encoding or a missing database
 * name (which pg fills with the user name) mean here what they mean to the
 * connection. IPv6 brackets and a trailing dot on the host are removed. */
function dbIdentity(url) {
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return null;
  let p;
  try {
    const mod = require('pg-connection-string');
    p = (mod.parse || mod)(url);
  } catch (_) { return null; }
  return {
    host: String(p.host || 'localhost').toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, ''),
    port: String(p.port || '5432'),
    database: String(p.database || p.user || ''),
  };
}

/* What a person types to confirm a wipe: the server as well as the database.
 * Every Railway Postgres database is named "railway", so a name alone cannot
 * tell a scratch copy from production. */
function targetLabel(url, actualDb) {
  const id = dbIdentity(url);
  return id ? id.host + ':' + id.port + '/' + (actualDb || id.database) : null;
}

function sameDatabase(a, b) {
  const x = dbIdentity(a);
  const y = dbIdentity(b);
  return !!(x && y && x.host === y.host && x.port === y.port && x.database === y.database);
}

/* Why the restore must not write to this target, or null if nothing obvious
 * stops it. This is the cheap check, done before connecting; the emptiness
 * check after connecting is the one that actually protects data. */
function refuseTarget(target, env) {
  if (!target) return 'RESTORE_DATABASE_URL is not set.';
  if (!dbIdentity(target)) return 'RESTORE_DATABASE_URL is not a postgres:// or postgresql:// URL.';
  for (const name of ['DATABASE_URL', 'DATABASE_PUBLIC_URL']) {
    if (env[name] && sameDatabase(target, env[name])) {
      return 'RESTORE_DATABASE_URL points at the same database as ' + name
        + '. A restore wipes its target; it will not run against the database the app uses.';
    }
  }
  if (/\.railway\.internal$/.test(dbIdentity(target).host)) {
    return 'RESTORE_DATABASE_URL is a Railway internal host — that is a running service\'s own database, not a scratch one.';
  }
  return null;
}

/* Parent-before-child order for loading without disabling foreign keys.
 * edges: [{ child, parent }]. Self-references are ignored here (they constrain
 * row order inside one table, not table order). Returns the order plus any
 * tables caught in a cycle, which no table order can satisfy. */
function topoOrder(tables, edges) {
  const set = new Set(tables);
  const deps = new Map(tables.map((t) => [t, new Set()]));
  for (const e of edges) {
    if (e.child === e.parent || !set.has(e.child) || !set.has(e.parent)) continue;
    deps.get(e.child).add(e.parent);
  }
  const order = [];
  const done = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (done.has(t)) continue;
      if ([...deps.get(t)].every((p) => done.has(p))) {
        order.push(t); done.add(t); progress = true;
      }
    }
  }
  const cyclic = tables.filter((t) => !done.has(t));
  return { order, cyclic };
}

/* Split a multi-statement SQL script on its top-level semicolons. Knows the
 * forms server/db.js uses: -- and nested block comments, '...' strings with ''
 * escapes, E'...' strings with backslash escapes, "quoted" identifiers, and
 * $tag$ ... $tag$ bodies (DO blocks, functions). $1-style parameters are not
 * dollar quotes. Statements that are only comments or whitespace are dropped. */
function splitSql(sql) {
  const out = [];
  const n = sql.length;
  let start = 0;
  let i = 0;
  const word = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);
  const push = (s) => {
    const bare = s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (bare) out.push(s.trim());
  };
  while (i < n) {
    const c = sql[i];
    const d = sql[i + 1];
    if (c === '-' && d === '-') {
      const j = sql.indexOf('\n', i);
      i = j === -1 ? n : j + 1;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth) {
        if (sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; } else if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; } else i++;
      }
      continue;
    }
    if (c === "'") {
      const escapes = /[eE]/.test(sql[i - 1] || '') && !word(sql[i - 2]);
      i++;
      while (i < n) {
        if (escapes && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === '$' && !word(sql[i - 1])) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80));
      if (m) {
        const j = sql.indexOf(m[0], i + m[0].length);
        i = j === -1 ? n : j + m[0].length;
        continue;
      }
    }
    if (c === ';') {
      push(sql.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  push(sql.slice(start));
  return out;
}

function human(n) {
  return n < 1024 ? n + ' B'
    : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
    : (n / 1048576).toFixed(1) + ' MB';
}

module.exports = {
  FORMAT,
  CHECKSUM_ALGO,
  SESSION_SETTINGS,
  KEEP_AS_TEXT_OIDS,
  JSON_OIDS,
  q,
  textDateTypes,
  checksumSql,
  encodeRow,
  jsonlLines,
  legacyDateValue,
  decodeRow,
  dbIdentity,
  targetLabel,
  sameDatabase,
  refuseTarget,
  topoOrder,
  splitSql,
  human,
};
