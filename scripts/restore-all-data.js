#!/usr/bin/env node
'use strict';

/**
 * restore-all-data.js — load an export-all-data.js archive into a SCRATCH
 * database and prove it came back intact.
 *
 * WHY THIS EXISTS
 * docs/KNOWN_ISSUES.md OPS-1: there was no backup, and no restore had ever
 * been tested. export-all-data.js fixed the first half. This is the second
 * half — until an archive has been read back and checked, it is a guess.
 *
 * THIS WIPES ITS TARGET. It is meant for an empty scratch database: a local
 * Postgres, or a throwaway Railway Postgres service. It is never pointed at
 * the database the app runs on, and it refuses to be:
 *   - the target comes ONLY from RESTORE_DATABASE_URL, never DATABASE_URL;
 *   - it refuses a target that matches DATABASE_URL or DATABASE_PUBLIC_URL
 *     in the same shell, or a Railway internal hostname;
 *   - it refuses a target that has any rows in it, in any schema, unless you
 *     pass --wipe-target AND --confirm-target <host:port/database>, exactly
 *     as this script prints it. The host is part of it on purpose: every
 *     Railway Postgres database is called "railway", so a database name
 *     alone cannot tell a scratch copy from production.
 *
 * USAGE — the connection string goes in the environment, not the command
 * line, so it does not land in your shell history:
 *
 *   # PowerShell
 *   $env:RESTORE_DATABASE_URL="postgresql://postgres:...@localhost:5432/p86_restore"
 *   node scripts/restore-all-data.js --from "D:/p86-backup-2026-10-07"
 *
 *   # bash
 *   export RESTORE_DATABASE_URL='postgresql://...'
 *   node scripts/restore-all-data.js --from ./p86-backup-2026-10-07
 *
 *   --wipe-target --confirm-target localhost:5432/p86_restore   # re-run over an earlier restore
 *
 * A remote scratch database that needs TLS: add ?sslmode=no-verify to the URL.
 *
 * WHAT IT DOES
 *   1. Builds the schema with the app's own server/db.js init(), in a child
 *      process (restore-build-schema.js — read its header: init() cannot
 *      build the schema on an empty database by itself).
 *   2. Empties every table (TRUNCATE ... RESTART IDENTITY). init() seeds rows
 *      of its own — the 'agx' organization, the roles, the admin user from
 *      ADMIN_EMAIL, app_settings — and the archive's copies would collide.
 *   3. Loads every table in ONE transaction, with foreign-key and other
 *      triggers off (session_replication_role = replica, which needs a
 *      superuser — a local Postgres or Railway's postgres user is one).
 *      Without a superuser it loads parent tables before child tables
 *      instead, and refuses if the foreign keys form a cycle. Format-2 rows
 *      go to Postgres as text and Postgres parses them, so JSONB numbers are
 *      never rewritten by JavaScript (archive-common.js JSON_OIDS).
 *   4. Puts every sequence back where the archive says it was, and never
 *      below the highest id actually loaded.
 *   5. CHECKS: row count per table against _manifest.json, the per-table
 *      checksum (format-2 archives), and that no row points at a parent that
 *      is not there. Any mismatch exits non-zero.
 *
 * OLD ARCHIVES (format 1, e.g. the 7 Oct 2026 one)
 * They load, with caveats this script cannot remove and will print:
 *   - no checksum, so only row counts are checked;
 *   - that export was not taken from one snapshot and paged with ORDER BY 1,
 *     so rows in composite-key tables may be duplicated or missing, and a
 *     child may reference a parent the archive does not contain. A duplicate
 *     shows up here as a primary-key error; a missing parent shows up in the
 *     orphan check;
 *   - numbers inside JSONB were already rewritten by JSON.parse when it was
 *     taken (12.50 -> 12.5; integers past 2^53 rounded), and real/double
 *     NaN or Infinity became null. Those cannot be put back.
 * DATE values in a format-1 archive were written as local midnight in UTC
 * (see archive-common.js legacyDateValue) and are converted back on load.
 *
 * AFTER A RESTORE, IF YOU BOOT THE APP ON IT
 * server/db.js re-seeds the admin user from ADMIN_EMAIL / ADMIN_PASSWORD on
 * every boot and overwrites that user's password hash. The restored data
 * still contains Microsoft OAuth tokens and MCP bearer tokens — treat the
 * scratch database with the same care as production, and drop it when done.
 * Files (photos, documents) are not in the archive; they live in R2.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pg = require('pg');
const A = require('./archive-common');

const ARGV = process.argv.slice(2);
function arg(name) {
  const i = ARGV.indexOf(name);
  return i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : null;
}
const FROM = arg('--from');
const WIPE = ARGV.includes('--wipe-target');
const CONFIRM_TARGET = arg('--confirm-target');
const BATCH_ROWS = Number(arg('--batch-rows')) || 500;
const BATCH_BYTES = 8 * 1024 * 1024;
const REPO = path.join(__dirname, '..');

function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function sslFor(url) {
  if (/[?&]sslmode=/.test(url)) return undefined;   // the URL says; let pg read it
  const id = A.dbIdentity(url);
  const local = id && (id.host === 'localhost' || id.host === '127.0.0.1' || id.host === '::1');
  return local ? false : { rejectUnauthorized: false };
}

function readManifest(dir) {
  const file = path.join(dir, '_manifest.json');
  if (!fs.existsSync(file)) fail('No _manifest.json in ' + dir + ' — is that an export-all-data.js directory?');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(m.tables)) fail('_manifest.json has no tables list.');
  m.format = m.format || 1;
  if (m.format > A.FORMAT) fail('This archive is format ' + m.format + '; this script reads up to ' + A.FORMAT + '.');
  for (const t of m.tables) {
    A.q(t.table);
    if (t.rows && !fs.existsSync(path.join(dir, t.file || ''))) fail('Missing data file for ' + t.table + ': ' + t.file);
    if (m.format >= 2 && t.rows && !Array.isArray(t.columns)) fail(t.table + ': a format-2 manifest entry has no column list.');
  }
  return m;
}

/* Rows in EVERY non-system schema, not just public: TRUNCATE below only
 * touches public, but a target with data anywhere is not an empty scratch
 * database, and that is what this check is for. */
async function rowTotal(client) {
  const { rows: tables } = await client.query(`
    SELECT n.nspname AS schema, c.relname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p')
       AND n.nspname NOT IN ('pg_catalog', 'information_schema')
       AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'`);
  let total = 0;
  for (const t of tables) {
    const { rows } = await client.query('SELECT COUNT(*)::bigint AS n FROM ' + A.q(t.schema) + '.' + A.q(t.name));
    total += Number(rows[0].n);
  }
  return { tables: tables.length, rows: total };
}

/* init() runs in its own process: db.js reads DATABASE_URL when it is first
 * required and builds a pool around it, and the modules init() pulls in may
 * start timers. A child that exits when init() resolves keeps both away from
 * this process — and keeps DATABASE_URL pointed at the target only there.
 *
 * The child is restore-build-schema.js, not a bare init(): init() cannot
 * build the schema on an EMPTY database (see that file's header), which is a
 * disaster-recovery finding in its own right. */
function buildSchema(target) {
  const env = Object.assign({}, process.env, { DATABASE_URL: target, P86_RESTORE_CHILD: '1' });
  delete env.DATABASE_PUBLIC_URL;
  /* db.js turns TLS on when NODE_ENV=production, which a local Postgres
   * cannot answer. A remote scratch target says what it needs with
   * ?sslmode= in its URL, which pg reads ahead of db.js's own setting. */
  if (sslFor(target) === false) env.NODE_ENV = 'development';
  const r = spawnSync(process.execPath, [path.join(__dirname, 'restore-build-schema.js')],
    { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  /* What the build said that a person should see: its own [restore] lines,
   * and init()'s warnings — e.g. a pg_trgm index it could not create. */
  const said = ((r.stdout || '') + '\n' + (r.stderr || '')).split('\n')
    .filter((l) => /^\[restore\]|WARNING|failed \(non-fatal\)|could not/i.test(l));
  said.forEach((l) => console.log('  ' + l.slice(0, 300)));
  if (r.status !== 0) {
    process.stderr.write((r.stdout || '').slice(-4000) + (r.stderr || '').slice(-4000));
    fail('Building the schema with server/db.js init() failed (exit ' + r.status + ').');
  }
}

async function targetColumns(client) {
  const { rows } = await client.query(`
    SELECT c.relname AS tbl, a.attname AS col,
           bt.typname AS base, (t.typcategory = 'A') AS is_array,
           (a.attidentity <> '') AS is_identity, a.attnotnull AS not_null
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      LEFT JOIN pg_type bt ON bt.oid = CASE WHEN t.typcategory = 'A' THEN t.typelem ELSE t.oid END
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`);
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.tbl)) map.set(r.tbl, { cols: {}, identity: false });
    const t = map.get(r.tbl);
    t.cols[r.col] = { base: r.base, isArray: r.is_array, notNull: r.not_null };
    if (r.is_identity) t.identity = true;
  }
  return map;
}

async function foreignKeys(client) {
  const { rows } = await client.query(`
    SELECT con.conname AS name, ch.relname AS child, pa.relname AS parent,
           array_agg(ca.attname::text ORDER BY k.ord) AS child_cols,      -- ::text: pg parses text[], not name[]
           array_agg(pa_att.attname::text ORDER BY k.ord) AS parent_cols
      FROM pg_constraint con
      JOIN pg_class ch ON ch.oid = con.conrelid
      JOIN pg_class pa ON pa.oid = con.confrelid
      JOIN pg_namespace n ON n.oid = ch.relnamespace
      CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(ck, pk, ord)
      JOIN pg_attribute ca ON ca.attrelid = con.conrelid AND ca.attnum = k.ck
      JOIN pg_attribute pa_att ON pa_att.attrelid = con.confrelid AND pa_att.attnum = k.pk
     WHERE con.contype = 'f' AND n.nspname = 'public'
     GROUP BY con.conname, ch.relname, pa.relname
     ORDER BY ch.relname, con.conname`);
  return rows;
}

/* The INSERT for one batch. Every row arrives as JSON text in $1 and
 * Postgres parses it. Most columns come from jsonb_populate_record; three
 * kinds are read straight from the JSON instead:
 *   jsonb  — x.r -> 'col': a missing key is SQL NULL, `null` is JSON null
 *            (the export leaves the key out for SQL NULL; see encodeRow);
 *   json   — format 2 writes it as a JSON string, cast back with ::json;
 *   bytea  — format 2 writes { __bytea: base64 }.
 *
 * FORMAT 1 wrote SQL NULL and JSON null the same way, as null. The only safe
 * reading: in a NOT NULL column it can only have been JSON null, so it stays
 * JSON null; in a nullable column it is taken as SQL NULL, which is what it
 * almost always is. Its bytea values were decoded in JavaScript already. */
function insertSql(table, cols, info, legacy) {
  const t = A.q(table);
  const kinds = legacy ? ['jsonb', 'json'] : ['jsonb', 'json', 'bytea'];
  const special = cols.filter((c) => kinds.includes(info.cols[c].base) && !info.cols[c].isArray);
  const lit = (c) => "'" + c + "'";   // c has passed A.q, so it holds no quote
  const sel = cols.map((c) => {
    if (!special.includes(c)) return 'p.' + A.q(c);
    const { base, notNull } = info.cols[c];
    const v = '(x.r -> ' + lit(c) + ')';
    if (legacy) {
      const j = notNull ? v : "(CASE WHEN " + v + " = 'null'::jsonb THEN NULL ELSE " + v + ' END)';
      return base === 'json' ? j + '::json' : j;
    }
    if (base === 'jsonb') return v;
    if (base === 'json') return '(x.r ->> ' + lit(c) + ')::json';
    return 'decode(x.r -> ' + lit(c) + " ->> '__bytea', 'base64')";
  });
  const strip = special.map((c) => ' - ' + lit(c)).join('');
  return 'INSERT INTO ' + t + ' (' + cols.map(A.q).join(', ') + ')'
    + (info.identity ? ' OVERRIDING SYSTEM VALUE' : '')
    + ' SELECT ' + sel.join(', ')
    + ' FROM jsonb_array_elements($1::jsonb) AS x(r)'
    + ' CROSS JOIN LATERAL jsonb_populate_record(NULL::' + t + ', x.r' + strip + ') AS p';
}

async function loadTable(client, dir, entry, info, legacy) {
  const file = path.join(dir, entry.file);
  let cols = legacy ? null : entry.columns.map((c) => c.name);
  let sql = null;
  let batch = [];
  let batchBytes = 0;
  let loaded = 0;

  const checkCols = () => {
    cols.forEach(A.q);
    const missing = cols.filter((c) => !info.cols[c]);
    if (missing.length) {
      fail(entry.table + ': the archive has column(s) this schema does not — ' + missing.join(', ')
        + '. Restoring would drop that data, so it stops here. Restore with the code version the archive was taken from.');
    }
  };
  if (cols) { checkCols(); sql = insertSql(entry.table, cols, info, false); }

  /* A format-2 line goes to Postgres AS TEXT and Postgres parses it (see
   * insertSql). A format-1 line was already through JSON.parse when it was
   * exported, so it is parsed here to put its dates and bytea back. */
  const flush = async () => {
    if (!batch.length) return;
    await client.query(sql, [legacy ? JSON.stringify(batch) : '[' + batch.join(',') + ']']);
    loaded += batch.length;
    batch = [];
    batchBytes = 0;
    if (process.stdout.isTTY) process.stdout.write('\r  ' + entry.table + ': ' + loaded + '/' + entry.rows + '   ');
  };

  for await (const line of A.jsonlLines(file)) {
    if (!line.trim()) continue;
    if (legacy) {
      const row = JSON.parse(line);
      if (!cols) { cols = Object.keys(row); checkCols(); sql = insertSql(entry.table, cols, info, true); }
      batch.push(A.decodeRow(row, info.cols, true));
    } else {
      batch.push(line);
    }
    batchBytes += line.length;
    if (batch.length >= BATCH_ROWS || batchBytes >= BATCH_BYTES) await flush();
  }
  await flush();
  console.log((process.stdout.isTTY ? '\r' : '') + '  ' + entry.table + ': ' + loaded + ' rows            ');
  return loaded;
}

async function resetSequences(client, manifest) {
  const { rows: owned } = await client.query(`
    SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
      FROM pg_class s
      JOIN pg_depend d ON d.objid = s.oid AND d.classid = 'pg_class'::regclass
                      AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
      JOIN pg_class t ON t.oid = d.refobjid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
      JOIN pg_namespace n ON n.oid = s.relnamespace
     WHERE s.relkind = 'S' AND n.nspname = 'public'`);
  const { rows: present } = await client.query(
    "SELECT sequencename AS name FROM pg_sequences WHERE schemaname = 'public'");
  const fromArchive = new Map((manifest.sequences || []).map((s) => [s.name, s.lastValue]));
  const ownedBy = new Map(owned.map((o) => [o.seq, o]));

  for (const { name } of present) {
    let target = fromArchive.has(name) && fromArchive.get(name) != null ? BigInt(fromArchive.get(name)) : 0n;
    const o = ownedBy.get(name);
    if (o) {
      const { rows: [m] } = await client.query('SELECT MAX(' + A.q(o.col) + ')::text AS m FROM ' + A.q(o.tbl));
      if (m.m != null && BigInt(m.m) > target) target = BigInt(m.m);
    }
    if (target > 0n) await client.query('SELECT setval($1::regclass, $2::bigint, true)', [A.q(name), target.toString()]);
  }
}

async function verify(client, manifest, fks) {
  const problems = [];
  let checked = 0;
  const algoOk = !manifest.checksumAlgo || manifest.checksumAlgo === A.CHECKSUM_ALGO;
  if (!algoOk) {
    problems.push('the archive\'s checksums use "' + manifest.checksumAlgo + '", which this script does not compute ("'
      + A.CHECKSUM_ALGO + '") — row counts were compared, checksums were not');
  }

  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  for (const s of A.SESSION_SETTINGS) await client.query(s);

  const listed = new Set();
  for (const t of manifest.tables) {
    listed.add(t.table);
    if (algoOk && t.checksum && t.checksum.value) {
      checked++;
      const { rows: [c] } = await client.query(A.checksumSql(t.table, t.checksum.columns));
      if (Number(c.n) !== Number(t.rows)) problems.push(t.table + ': ' + c.n + ' rows, archive has ' + t.rows);
      else if (c.sum !== t.checksum.value) problems.push(t.table + ': row count matches but the checksum does not — the data differs');
    } else {
      const { rows: [c] } = await client.query('SELECT COUNT(*)::bigint AS n FROM ' + A.q(t.table));
      if (Number(c.n) !== Number(t.rows)) problems.push(t.table + ': ' + c.n + ' rows, archive has ' + t.rows);
    }
  }

  const { rows: extra } = await client.query(`
    SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY 1`);
  const newer = extra.map((r) => r.name).filter((n) => !listed.has(n));

  for (const fk of fks) {
    const notNull = fk.child_cols.map((c) => 'c.' + A.q(c) + ' IS NOT NULL').join(' AND ');
    const match = fk.child_cols.map((c, i) => 'p.' + A.q(fk.parent_cols[i]) + ' = c.' + A.q(c)).join(' AND ');
    const { rows: [o] } = await client.query(
      'SELECT COUNT(*)::bigint AS n FROM ' + A.q(fk.child) + ' c WHERE ' + notNull
      + ' AND NOT EXISTS (SELECT 1 FROM ' + A.q(fk.parent) + ' p WHERE ' + match + ')');
    if (Number(o.n)) {
      problems.push(fk.child + '.' + fk.child_cols.join(',') + ': ' + o.n + ' row(s) point at a missing ' + fk.parent + ' (' + fk.name + ')');
    }
  }
  await client.query('COMMIT');
  return { problems, newer, checked };
}

async function main() {
  if (ARGV.includes('--confirm-db')) {
    fail('--confirm-db is gone: every Railway database is called "railway", so a name alone proves nothing.'
      + ' Use --confirm-target <host:port/database> exactly as this script prints it.');
  }
  if (!FROM) fail('Usage: node scripts/restore-all-data.js --from <export directory>   (target in RESTORE_DATABASE_URL)');
  const target = process.env.RESTORE_DATABASE_URL || '';
  const refusal = A.refuseTarget(target, process.env);
  if (refusal) fail(refusal);

  const dir = path.resolve(FROM);
  const manifest = readManifest(dir);
  const legacy = manifest.format === 1;
  console.log('\nArchive: ' + dir);
  console.log('  format ' + manifest.format + ', taken ' + (manifest.takenAt || 'unknown')
    + ', ' + manifest.tables.length + ' tables, ' + (manifest.totalRows || 0) + ' rows');
  if (legacy) {
    console.log('  FORMAT 1: no checksums (row counts only), the export was not a single snapshot,');
    console.log('  and JSONB numbers were already rewritten by JSON.parse when it was taken.');
    console.log('  Duplicates or orphans below are the archive, not this restore.');
  }

  const client = new pg.Client({ connectionString: target, ssl: sslFor(target), types: A.textDateTypes(pg.types) });
  await client.connect();
  try {
    const { rows: [db] } = await client.query(
      'SELECT current_database() AS name, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser');
    const where = A.targetLabel(target, db.name);
    console.log('\nTarget: ' + where + (db.superuser ? ' (superuser)' : ' (not a superuser)'));

    const before = await rowTotal(client);
    if (before.rows > 0) {
      if (!WIPE || CONFIRM_TARGET !== where) {
        fail('The target ' + where + ' already holds ' + before.rows + ' rows in ' + before.tables + ' tables. A restore wipes it.\n'
          + 'If that database really is a scratch copy, re-run with:  --wipe-target --confirm-target ' + where);
      }
      console.log('  holds ' + before.rows + ' rows — wiping, as --wipe-target --confirm-target ' + where + ' asked.');
    }

    console.log('\n1/5 building the schema with server/db.js init() ...');
    buildSchema(target);

    const info = await targetColumns(client);
    const absent = manifest.tables.filter((t) => !info.has(t.table)).map((t) => t.table);
    if (absent.length) {
      fail('The archive has table(s) this schema does not build: ' + absent.join(', ')
        + '. Restore with the code version the archive was taken from.');
    }
    const fks = await foreignKeys(client);

    let order = manifest.tables.filter((t) => t.rows);
    if (!db.superuser) {
      const topo = A.topoOrder(order.map((t) => t.table), fks.map((f) => ({ child: f.child, parent: f.parent })));
      if (topo.cyclic.length) {
        fail('Without a superuser the tables have to load parent-first, and these form a foreign-key cycle: '
          + topo.cyclic.join(', ') + '. Connect as a superuser (session_replication_role needs one).');
      }
      const byName = new Map(order.map((t) => [t.table, t]));
      order = topo.order.map((n) => byName.get(n));
    }

    console.log('2/5 emptying every table init() seeded ...');
    console.log('3/5 loading ' + order.length + ' non-empty tables in one transaction ...\n');
    const loadProblems = [];
    await client.query('BEGIN');
    try {
      for (const s of A.SESSION_SETTINGS) await client.query(s);
      /* No CASCADE: every public table is named, so references between them
       * are covered, and a foreign key from OUTSIDE public makes this fail
       * rather than silently empty a table the emptiness check never saw. */
      const all = [...info.keys()].map(A.q).join(', ');
      await client.query('TRUNCATE TABLE ' + all + ' RESTART IDENTITY');
      if (db.superuser) await client.query('SET LOCAL session_replication_role = replica');
      for (const entry of order) {
        const n = await loadTable(client, dir, entry, info.get(entry.table), legacy);
        if (n !== Number(entry.rows)) loadProblems.push(entry.table + ': its file has ' + n + ' rows, the manifest says ' + entry.rows);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    }

    console.log('\n4/5 resetting sequences ...');
    await resetSequences(client, manifest);

    console.log('5/5 checking the restore against _manifest.json ...');
    const { problems, newer, checked } = await verify(client, manifest, fks);
    problems.unshift(...loadProblems);
    if (Array.isArray(manifest.problems) && manifest.problems.length) {
      problems.unshift(...manifest.problems.map((p) => 'the export itself reported: ' + p));
    }

    console.log('\n' + '='.repeat(60));
    if (newer.length) {
      console.log('Tables this code builds that the archive predates (left empty): ' + newer.join(', '));
    }
    if (problems.length) {
      console.log('RESTORE DID NOT CHECK OUT — ' + problems.length + ' problem(s):');
      problems.forEach((p) => console.log('  - ' + p));
      process.exitCode = 1;
    } else {
      const tables = manifest.tables.length;
      console.log('RESTORE CHECKS OUT: all ' + tables + ' tables match the archive\'s row counts'
        + (checked === tables ? ', every table\'s checksum matches,'
          : checked ? ', ' + checked + ' of ' + tables + ' tables were also checksummed and match,'
            : ' (the archive has no checksums, so the DATA itself was not compared),')
        + ' and no row points at a missing parent.');
    }
    console.log('\nIf you boot the app on this database: it re-seeds the admin user from');
    console.log('ADMIN_EMAIL / ADMIN_PASSWORD and overwrites that password. The data holds');
    console.log('OAuth and MCP tokens in plain text — drop this database when you are done.');
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n' + (e.userFacing ? 'REFUSED / STOPPED: ' + e.message : (e.stack || e)));
    process.exitCode = 1;
  });
}

module.exports = { main };
