#!/usr/bin/env node
'use strict';

/**
 * export-all-data.js — take a full copy of the Project 86 database.
 *
 * WHY THIS EXISTS
 * There has never been a backup. docs/KNOWN_ISSUES.md logs it as OPS-1,
 * priority 1, and notes that no restore has ever been tested. Two other files
 * in this repository look like backup provisions and are not: deploy/setup.sh
 * copies a SQLite file this Postgres app does not have, and
 * docs/proprietary-model-v1.md refers to "DB backups" that do not exist.
 *
 * This writes one JSONL file per table plus a manifest. It is READ ONLY: the
 * whole export runs inside one READ ONLY transaction, so the database refuses
 * any write even if a bug in here tried one.
 *
 * USAGE — the connection string is never passed on the command line, so it
 * does not land in your shell history:
 *
 *   # PowerShell
 *   $env:DATABASE_URL="<paste DATABASE_PUBLIC_URL from Railway>"
 *   node scripts/export-all-data.js
 *
 *   # bash
 *   export DATABASE_URL='<paste DATABASE_PUBLIC_URL from Railway>'
 *   node scripts/export-all-data.js
 *
 *   node scripts/export-all-data.js --out D:/p86-backup   # choose a directory
 *   node scripts/export-all-data.js --counts-only         # just size the job
 *   node scripts/export-all-data.js --no-checksum         # skip per-table checksums
 *
 * Use DATABASE_PUBLIC_URL, not DATABASE_URL, when running from your own
 * machine — the internal one only resolves inside Railway's network.
 *
 * WHAT CHANGED FROM THE FIRST VERSION (format 1, the 7 Oct 2026 archive)
 *
 *   1. ROWS COULD BE DUPLICATED OR SKIPPED. Each table was paged with
 *      `ORDER BY 1 LIMIT 5000 OFFSET n`, and ORDER BY 1 only sorts by the
 *      first column. Where that column is not unique — every composite-key
 *      table, e.g. bt_record_snapshots (organization_id, dataset, bt_id) with
 *      one org, so EVERY row ties — Postgres may return tied rows in a
 *      different order on each page, and a row can land on two pages or none.
 *      It only bites past 5000 rows, which is why the row counts still looked
 *      right: the count was taken separately, and a duplicate and a miss
 *      cancel out. Now each table is read once, start to finish, through a
 *      server-side cursor. No ORDER BY, no OFFSET, every row exactly once.
 *
 *   2. THE TABLES WERE NOT FROM ONE MOMENT. Counts and pages were separate
 *      autocommit queries, so a row written mid-export could be counted and
 *      not exported, and a child row could be exported whose parent was not.
 *      Now the counts, the rows, the checksums and the sequence positions all
 *      come from one REPEATABLE READ snapshot. A count that disagrees with
 *      the rows written is a bug, and the script exits non-zero on it.
 *
 *   3. DATES DEPENDED ON THE EXPORTING MACHINE'S TIME ZONE. node-postgres
 *      turns DATE and TIMESTAMPTZ into JavaScript Dates, which drops
 *      microseconds and turns a DATE into local midnight printed in UTC.
 *      Date and time values are now kept as Postgres's own text.
 *      restore-all-data.js knows how to read the old spelling back.
 *
 *   3b. NUMBERS INSIDE JSONB WERE REWRITTEN. node-postgres parses jsonb with
 *      JSON.parse: 3.0 became 3, 12.50 became 12.5, and integers past 2^53
 *      were rounded. JSON/JSONB values are now written as the exact JSON
 *      text Postgres printed (archive-common.js JSON_OIDS). The 7 Oct
 *      archive cannot be repaired on this point: the original text is gone.
 *
 *   4. A CHECKSUM PER TABLE. The manifest now records an md5 over every
 *      table's rows (see archive-common.js checksumSql), so a restore can
 *      prove the data is the same, not just the row count.
 *
 *   5. SEQUENCE POSITIONS. The next id each serial column would hand out is
 *      recorded, so a restore does not reissue an id that was already used.
 *
 *   6. IT GETS OUT OF A DEPLOY'S WAY. One long transaction holds a share lock
 *      on every table it has read, and a deploy's boot migration (ALTER
 *      TABLE) has to wait for those — with production's queries queued behind
 *      it. Between batches the export checks whether it is blocking anyone
 *      and, if it is, stops at once without writing a manifest. Run it when
 *      no deploy is in flight; if it stops, run it again afterwards.
 *
 * RESTORING
 * scripts/restore-all-data.js reads these files into an EMPTY scratch
 * database and checks the result against _manifest.json. Run it. A backup
 * nobody has restored is a guess, which is the exact finding OPS-1 has been
 * carrying since August.
 */

const fs = require('fs');
const path = require('path');
const pg = require('pg');
const A = require('./archive-common');

const ARGV = process.argv.slice(2);
const COUNTS_ONLY = ARGV.includes('--counts-only');
const NO_CHECKSUM = ARGV.includes('--no-checksum');
const OUT = (() => {
  const i = ARGV.indexOf('--out');
  if (i !== -1 && ARGV[i + 1]) return ARGV[i + 1];
  const d = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), 'p86-backup-' + d);
})();
const FETCH = 1000;

/* Railway terminates TLS with its own chain; server/db.js does the same
 * thing. A local scratch database usually has no TLS at all, so localhost is
 * the one place this connects in the clear. */
function sslFor(url) {
  const id = A.dbIdentity(url);
  const local = id && (id.host === 'localhost' || id.host === '127.0.0.1' || id.host === '::1');
  return local ? false : { rejectUnauthorized: false };
}

/* A table file that remembers a write error and reports it at close. The
 * end() callback receives the error BEFORE the 'error' event fires, so
 * listening for 'error' alone let a failed final flush (a full USB drive, a
 * sync folder that went away) resolve as success with a short file. */
function openOut(file) {
  const out = fs.createWriteStream(file, { flags: 'w' });
  let failed = null;
  let bytes = 0;
  out.on('error', (e) => { failed = failed || e; });
  return {
    async write(line) {
      if (failed) throw failed;
      bytes += Buffer.byteLength(line);
      if (!out.write(line)) await new Promise((res, rej) => { out.once('drain', res); out.once('error', rej); });
    },
    async close() {
      await new Promise((res, rej) => out.end((e) => (e ? rej(e) : res())));
      if (failed) throw failed;
      return bytes;
    },
  };
}

/* WHO IS WAITING ON THIS EXPORT. The whole export is one transaction, so it
 * holds a share lock on every table it has read until it finishes. Reads and
 * normal writes do not care, but a deploy does: server/db.js runs ALTER TABLE
 * on boot, an ALTER waits for this export's lock, and every query on that
 * table then queues behind the ALTER — production stops answering for as long
 * as the export runs. So between batches the export asks whether any other
 * session is blocked by it, and if one is, it gives up at once and says so.
 * No manifest is written, so the half-written directory cannot be mistaken
 * for a backup. */
async function stopIfBlockingOthers(client) {
  /* pg_locks, not pg_stat_activity: a transaction reads pg_stat_activity
   * ONCE and keeps that copy until it ends, so from inside this export's one
   * long transaction a migration that started afterwards never appears there.
   * pg_locks is read live on every call. Measured: with pg_stat_activity the
   * check never fired and an ALTER TABLE waited out the whole export. */
  const { rows: [r] } = await client.query(
    'SELECT COUNT(DISTINCT pid)::int AS n FROM pg_locks'
    + ' WHERE NOT granted AND pid <> pg_backend_pid() AND pg_backend_pid() = ANY(pg_blocking_pids(pid))');
  if (r.n) {
    const e = new Error(r.n + ' other database session(s) — most likely a deploy running its migration — are waiting on'
      + ' this export\'s locks. Stopped to let production through; nothing was written to the database. Re-run the'
      + ' export when the deploy has finished. This directory has no _manifest.json and is NOT a backup.');
    e.userFacing = true;
    throw e;
  }
}

async function main() {
  const url = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
  if (!url) {
    console.error('\nSet DATABASE_URL first (use Railway\'s DATABASE_PUBLIC_URL when running');
    console.error('from your own machine — the internal host only resolves inside Railway).\n');
    console.error('  PowerShell:  $env:DATABASE_URL="postgresql://..."');
    console.error('  bash:        export DATABASE_URL=\'postgresql://...\'\n');
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({
    connectionString: url,
    ssl: sslFor(url),
    types: A.textDateTypes(pg.types),
  });
  await client.connect();

  try {
    /* One snapshot for everything below. READ ONLY makes the database itself
     * refuse a write; REPEATABLE READ makes every query see the same moment. */
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const s of A.SESSION_SETTINGS) await client.query(s);

    const { rows: [info] } = await client.query(
      "SELECT current_database() AS db, current_setting('server_version') AS version");

    const { rows: tables } = await client.query(`
      SELECT c.relname AS name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`);

    const { rows: colRows } = await client.query(`
      SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS type
        FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY c.relname, a.attnum`);
    const columnsOf = new Map();
    for (const r of colRows) {
      if (!columnsOf.has(r.tbl)) columnsOf.set(r.tbl, []);
      columnsOf.get(r.tbl).push({ name: r.col, type: r.type });
    }

    console.log('\n' + tables.length + ' tables in ' + info.db + ' (Postgres ' + info.version + ').\n');

    /* Exact counts. reltuples is an estimate and a backup is not a place for
     * estimates — the manifest has to be checkable against a restore. */
    const plan = [];
    let grand = 0;
    for (const t of tables) {
      const { rows } = await client.query('SELECT COUNT(*)::bigint AS n FROM ' + A.q(t.name));
      const n = Number(rows[0].n);
      grand += n;
      plan.push({ table: t.name, rows: n });
    }

    plan.slice().sort((a, b) => b.rows - a.rows).slice(0, 15).forEach((p) => {
      if (p.rows) console.log('  ' + String(p.rows).padStart(9) + '  ' + p.table);
    });
    const empties = plan.filter((p) => !p.rows).length;
    console.log('\n  ' + String(grand).padStart(9) + '  TOTAL ROWS   (' + empties + ' tables are empty)\n');

    if (COUNTS_ONLY) { await client.query('COMMIT'); return; }

    fs.mkdirSync(OUT, { recursive: true });
    console.log('writing to ' + OUT + '\n');

    let bytes = 0;
    const problems = [];
    const manifest = {
      format: A.FORMAT,
      takenAt: new Date().toISOString(),
      database: info.db,
      serverVersion: info.version,
      snapshot: 'one REPEATABLE READ READ ONLY transaction',
      session: A.SESSION_SETTINGS,
      checksumAlgo: NO_CHECKSUM ? null : A.CHECKSUM_ALGO,
      tables: [],
    };

    for (const p of plan) {
      const columns = columnsOf.get(p.table) || [];
      const entry = { table: p.table, rows: p.rows, file: null, columns };
      await stopIfBlockingOthers(client);

      if (p.rows) {
        const file = path.join(OUT, p.table + '.jsonl');
        const out = openOut(file);
        let written = 0;

        /* A cursor reads the table once, in whatever order Postgres stores
         * it, and hands it over FETCH rows at a time — so nothing is skipped
         * or repeated, and a large table is never held in memory. */
        await client.query('DECLARE p86_export NO SCROLL CURSOR FOR SELECT * FROM ' + A.q(p.table));
        for (;;) {
          const { rows, fields } = await client.query('FETCH FORWARD ' + FETCH + ' FROM p86_export');
          if (!rows.length) break;
          const rawJson = new Set(fields.filter((f) => A.JSON_OIDS.has(f.dataTypeID)).map((f) => f.name));
          for (const r of rows) {
            await out.write(A.encodeRow(r, rawJson) + '\n');
            written++;
          }
          if (process.stdout.isTTY) process.stdout.write('\r  ' + p.table + ': ' + written + '/' + p.rows + '   ');
          await stopIfBlockingOthers(client);
        }
        await client.query('CLOSE p86_export');
        const sent = await out.close();

        const size = fs.statSync(file).size;
        bytes += size;
        Object.assign(entry, { rows: written, file: p.table + '.jsonl', bytes: size });
        console.log((process.stdout.isTTY ? '\r' : '') + '  ' + p.table + ': ' + written + ' rows, ' + A.human(size) + '            ');

        if (written !== p.rows) {
          problems.push(p.table + ': counted ' + p.rows + ' in the snapshot, wrote ' + written);
        }
        if (size !== sent) {
          problems.push(p.table + ': wrote ' + sent + ' bytes but the file on disk is ' + size);
        }
      }

      if (!NO_CHECKSUM && columns.length) {
        await stopIfBlockingOthers(client);
        const { rows: [c] } = await client.query(A.checksumSql(p.table, columns.map((x) => x.name)));
        entry.checksum = { columns: columns.map((x) => x.name).sort(), value: c.sum };
        if (Number(c.n) !== entry.rows) {
          problems.push(p.table + ': checksum saw ' + c.n + ' rows, export wrote ' + entry.rows);
        }
      }

      manifest.tables.push(entry);
    }

    /* Where each sequence has got to. A sequence is not transactional, so
     * this can be AHEAD of the snapshot — which is the safe direction: a
     * restore that starts numbering a little high never collides. */
    const { rows: seqs } = await client.query(`
      SELECT sequencename AS name, last_value::text AS last_value
        FROM pg_sequences
       WHERE schemaname = 'public'
       ORDER BY sequencename`);
    manifest.sequences = seqs.map((s) => ({ name: s.name, lastValue: s.last_value }));

    await client.query('COMMIT');

    manifest.totalRows = grand;
    manifest.totalBytes = bytes;
    manifest.problems = problems;     // restore-all-data.js refuses to call an archive with problems good
    fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2));

    console.log('\n' + '='.repeat(60));
    console.log('DONE — ' + grand + ' rows, ' + A.human(bytes) + ' in ' + OUT);
    console.log('_manifest.json records the row count' + (NO_CHECKSUM ? '' : ' and a checksum') + ' per table.');
    console.log('Prove it with: node scripts/restore-all-data.js --from "' + OUT + '"');
    console.log('(into a SCRATCH database — see that script\'s header).');
    console.log('\nTHIS FILE SET CONTAINS SECRETS: Microsoft OAuth tokens, MCP');
    console.log('connector bearer tokens stored in plain text, and possibly the');
    console.log('web-push private key. Encrypt it at rest and do not email it.');
    console.log('\nThe photos and documents are NOT in here — those live in the');
    console.log('Cloudflare R2 bucket and need a separate copy.');

    if (problems.length) {
      console.error('\n!! THIS EXPORT DID NOT CHECK OUT. Inside one snapshot these must agree:');
      problems.forEach((m) => console.error('   ' + m));
      process.exitCode = 1;
    }
  } finally {
    await client.end().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((e) => {
    if (e.userFacing) {
      console.error('\nSTOPPED: ' + e.message);
    } else {
      console.error('\n' + (e.stack || e));
      console.error('\nIf this is a connection error, check you used DATABASE_PUBLIC_URL');
      console.error('rather than the internal DATABASE_URL.');
    }
    process.exitCode = 1;
  });
}

module.exports = { main };
