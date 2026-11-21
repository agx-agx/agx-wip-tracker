'use strict';

// THE PROOF THAT A BACKUP RESTORES. export-all-data.js -> restore-all-data.js
// against real Postgres, then every table compared row-for-row by checksum.
//
// It needs a SCRATCH Postgres it may create and drop databases on, given as
// an admin connection string:
//
//   P86_SCRATCH_PG_URL=postgresql://postgres@localhost:5432/postgres npx jest test/archive-round-trip
//
// Without it the suite is SKIPPED, visibly — not silently passed. It never
// reads DATABASE_URL, and it refuses a P86_SCRATCH_PG_URL that matches it.
//
// What it seeds is chosen to break the first export, and each thing the
// adversarial review of this one found:
//   - 12,000 bt_record_snapshots rows that ALL tie on the first column
//     (organization_id), more than two 5000-row OFFSET pages;
//   - timestamptz with microseconds, DATE, NUMERIC, JSONB with non-ASCII
//     text, 12.50 / 3.0 / an integer past 2^53, and JSON null next to SQL
//     NULL in the same column;
//   - U+2028 / U+2029 in text, on the first line of a file and later ones;
//   - real columns holding NaN, ±Infinity and -0;
//   - a users sequence moved past the highest id, so a restore that only
//     takes MAX(id) is caught.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const A = require('../scripts/archive-common');

const ADMIN = process.env.P86_SCRATCH_PG_URL || '';
const REPO = path.join(__dirname, '..');
const run = ADMIN ? describe : describe.skip;

const TAG = 'p86_rt_' + process.pid;
const SRC = TAG + '_src';
const DST = TAG + '_dst';
const urlFor = (db) => { const u = new URL(ADMIN); u.pathname = '/' + db; return u.toString(); };
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function node(args, env) {
  const clean = Object.assign({}, process.env, { NODE_ENV: 'development' });
  delete clean.DATABASE_URL;
  delete clean.DATABASE_PUBLIC_URL;
  delete clean.RESTORE_DATABASE_URL;
  delete clean.ADMIN_EMAIL;
  delete clean.ADMIN_PASSWORD;
  const r = spawnSync(process.execPath, args, { cwd: REPO, env: Object.assign(clean, env), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

async function withClient(db, fn) {
  const c = new Client({ connectionString: urlFor(db) });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}

async function checksums(db) {
  return withClient(db, async (c) => {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    for (const s of A.SESSION_SETTINGS) await c.query(s);
    const { rows } = await c.query(`
      SELECT c.relname AS tbl, array_agg(a.attname::text) AS cols
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
       GROUP BY c.relname ORDER BY c.relname`);
    const out = {};
    for (const r of rows) {
      const { rows: [s] } = await c.query(A.checksumSql(r.tbl, r.cols));
      out[r.tbl] = s.n + ':' + s.sum;
    }
    await c.query('COMMIT');
    return out;
  });
}

const restore = (from, extra) => node(['scripts/restore-all-data.js', '--from', from].concat(extra || []),
  { RESTORE_DATABASE_URL: urlFor(DST) });

run('archive round trip (scratch Postgres)', () => {
  let tmp;
  let archive;
  let where;

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-archive-'));
    archive = path.join(tmp, 'archive');
    where = A.targetLabel(urlFor(DST), DST);
    if (process.env.DATABASE_URL && A.sameDatabase(ADMIN, process.env.DATABASE_URL)) {
      throw new Error('P86_SCRATCH_PG_URL matches DATABASE_URL — refusing to touch it.');
    }
    await withClient(new URL(ADMIN).pathname.slice(1) || 'postgres', async (c) => {
      for (const db of [SRC, DST]) {
        await c.query('DROP DATABASE IF EXISTS ' + A.q(db) + ' WITH (FORCE)');
        await c.query('CREATE DATABASE ' + A.q(db) + " TEMPLATE template0 ENCODING 'UTF8'");
      }
    });

    // The source is built the way restore builds its target: a bare init()
    // cannot build the schema on an empty database (scripts/restore-build-schema.js).
    const built = node(['scripts/restore-build-schema.js'], { DATABASE_URL: urlFor(SRC), P86_RESTORE_CHILD: '1' });
    if (built.status !== 0) throw new Error('building the source schema failed:\n' + built.out.slice(-3000));

    await withClient(SRC, async (c) => {
      const orgId = (await c.query("SELECT id FROM organizations WHERE slug = 'agx'")).rows[0].id;
      // The one organizations row is the FIRST line of its file.
      await c.query("UPDATE organizations SET name = 'AG' || chr(8232) || 'Exteriors' WHERE id = $1", [orgId]);
      await c.query(`
        INSERT INTO bt_record_snapshots (organization_id, dataset, bt_id, snapshot, first_seen_at, last_seen_at, prev_snapshot)
        SELECT $1, CASE WHEN g % 3 = 0 THEN 'leads' ELSE 'jobs' END, 'bt-' || g,
               jsonb_build_object('name', 'Café Ñandú № ' || g || ' 🏗', 'tags', jsonb_build_array(g, 'x', NULL), 'nested', jsonb_build_object('n', g * 1.5)),
               timestamptz '2026-10-07 03:21:00.123456+00' + (g || ' seconds')::interval + (g || ' microseconds')::interval,
               now(),
               CASE WHEN g % 500 = 0 THEN 'null'::jsonb ELSE NULL END
          FROM generate_series(1, 12000) g`, [orgId]);
      await c.query(`
        INSERT INTO users (id, email, password_hash, name, role, created_at, notification_prefs)
        VALUES (500, 'rt@example.test', 'x', 'Zoë O''Brien — test', 'pm', timestamptz '2026-01-02 03:04:05.678901+00',
                '{"amount": 12.50, "big": 9007199254740993, "n": 3.0, "s": "tab\\there"}'::jsonb),
               (501, 'rt2@example.test', 'x', 'Para' || chr(8232) || 'graph' || chr(8233), 'pm', now(), 'null'::jsonb)`);
      await c.query("SELECT setval(pg_get_serial_sequence('users', 'id'), 900)");
      await c.query(`
        INSERT INTO leads (id, title, projected_sale_date, estimated_revenue_low, estimated_revenue_high)
        VALUES ('lead-rt-1', 'Latitude 2021 fire', DATE '2026-10-07', 420098.70, 0.01),
               ('lead-rt-2', 'Leap day', DATE '2028-02-29', NULL, 99999999.99)`);
      await c.query(`
        INSERT INTO tasks (id, organization_id, title, lat, lng, checklist)
        VALUES ('task-rt-1', $1, 'floats', 'NaN', '-Infinity', 'null'::jsonb),
               ('task-rt-2', $1, 'more floats', '-0', 'Infinity', '[]'::jsonb)`, [orgId]);
    });
  }, 300000);

  afterAll(async () => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    await withClient(new URL(ADMIN).pathname.slice(1) || 'postgres', async (c) => {
      for (const db of [SRC, DST]) await c.query('DROP DATABASE IF EXISTS ' + A.q(db) + ' WITH (FORCE)');
    }).catch((e) => console.warn('[round-trip] could not drop ' + SRC + '/' + DST + ': ' + e.message));
  }, 120000);

  test('the export writes every tied row exactly once, and records the sequences', () => {
    const r = node(['scripts/export-all-data.js', '--out', archive], { DATABASE_URL: urlFor(SRC) });
    expect(r.out).not.toMatch(/DID NOT CHECK OUT/);
    expect(r.status).toBe(0);

    const m = JSON.parse(fs.readFileSync(path.join(archive, '_manifest.json'), 'utf8'));
    expect(m.format).toBe(2);
    expect(m.problems).toEqual([]);
    expect(m.checksumAlgo).toBe(A.CHECKSUM_ALGO);
    const snap = m.tables.find((t) => t.table === 'bt_record_snapshots');
    expect(snap.rows).toBe(12000);
    expect(snap.checksum.value).toMatch(/^[0-9a-f]{32}$/);
    expect(m.sequences.find((s) => s.name === 'users_id_seq').lastValue).toBe('900');

    const keys = new Set(fs.readFileSync(path.join(archive, 'bt_record_snapshots.jsonl'), 'utf8')
      .trim().split('\n').map((l) => { const r2 = JSON.parse(l); return r2.dataset + '/' + r2.bt_id; }));
    expect(keys.size).toBe(12000);

    const lead = fs.readFileSync(path.join(archive, 'leads.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .find((l) => l.id === 'lead-rt-1');
    expect(lead.projected_sale_date).toBe('2026-10-07');

    for (const f of fs.readdirSync(archive)) {
      const body = fs.readFileSync(path.join(archive, f), 'utf8');
      expect(body.includes(LS) || body.includes(PS)).toBe(false);
    }
  }, 300000);

  test('restore into an empty database matches the source table-for-table', async () => {
    const r = restore(archive);
    expect(r.out).toMatch(/RESTORE CHECKS OUT: all \d+ tables match the archive's row counts, every table's checksum matches/);
    expect(r.status).toBe(0);

    const [a, b] = [await checksums(SRC), await checksums(DST)];
    const differ = Object.keys(a).filter((t) => a[t] !== b[t]);
    expect(differ).toEqual([]);
    expect(Object.keys(b).sort()).toEqual(Object.keys(a).sort());
  }, 600000);

  test('JSONB numbers come back exactly — 12.50, 3.0, and an integer past 2^53', async () => {
    await withClient(DST, async (c) => {
      const { rows: [u] } = await c.query('SELECT notification_prefs::text AS p FROM users WHERE id = 500');
      expect(u.p).toBe('{"n": 3.0, "s": "tab\\there", "big": 9007199254740993, "amount": 12.50}');
    });
  });

  test('JSON null and SQL NULL stay different', async () => {
    await withClient(DST, async (c) => {
      const { rows: [s] } = await c.query(`SELECT
          COUNT(*) FILTER (WHERE prev_snapshot IS NULL)::int AS sql_null,
          COUNT(*) FILTER (WHERE prev_snapshot = 'null'::jsonb)::int AS json_null
        FROM bt_record_snapshots`);
      expect(s).toEqual({ sql_null: 11976, json_null: 24 });
      const { rows: [u] } = await c.query('SELECT notification_prefs::text AS p FROM users WHERE id = 501');
      expect(u.p).toBe('null');
    });
  });

  test('U+2028/U+2029 text survives, first line of a file or not', async () => {
    await withClient(DST, async (c) => {
      const { rows: [o] } = await c.query("SELECT name FROM organizations WHERE slug = 'agx'");
      expect(o.name).toBe('AG' + LS + 'Exteriors');
      const { rows: [u] } = await c.query('SELECT name FROM users WHERE id = 501');
      expect(u.name).toBe('Para' + LS + 'graph' + PS);
    });
  });

  test('real NaN, ±Infinity and -0 survive', async () => {
    await withClient(DST, async (c) => {
      const { rows } = await c.query("SELECT id, lat::text AS lat, lng::text AS lng FROM tasks WHERE id LIKE 'task-rt-%' ORDER BY id");
      expect(rows).toEqual([
        { id: 'task-rt-1', lat: 'NaN', lng: '-Infinity' },
        { id: 'task-rt-2', lat: '-0', lng: 'Infinity' },
      ]);
    });
  });

  test('sequences resume from the archive\'s position, not just above MAX(id)', async () => {
    await withClient(DST, async (c) => {
      const { rows: [n] } = await c.query("SELECT nextval(pg_get_serial_sequence('users', 'id'))::int AS id");
      expect(n.id).toBe(901);
    });
  });

  test('a second restore over the now non-empty target is refused, naming the server', () => {
    const r = restore(archive);
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/already holds \d+ rows/);
    expect(r.out).toContain('--wipe-target --confirm-target ' + where);
  });

  test('--wipe-target needs the exact host:port/database, and then works', () => {
    expect(restore(archive, ['--wipe-target', '--confirm-db', DST]).out).toMatch(/--confirm-db is gone/);
    expect(restore(archive, ['--wipe-target', '--confirm-target', DST]).status).not.toBe(0);
    expect(restore(archive, ['--wipe-target', '--confirm-target', 'otherhost:5432/' + DST]).status).not.toBe(0);

    const right = restore(archive, ['--wipe-target', '--confirm-target', where]);
    expect(right.out).toMatch(/RESTORE CHECKS OUT/);
    expect(right.status).toBe(0);
  }, 600000);

  test('it will not restore over the database DATABASE_URL points at', () => {
    const r = node(['scripts/restore-all-data.js', '--from', archive],
      { RESTORE_DATABASE_URL: urlFor(SRC), DATABASE_URL: urlFor(SRC) });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/same database as DATABASE_URL/);
  });

  test('a --no-checksum archive restores without claiming checksums it did not compare', () => {
    const plain = path.join(tmp, 'plain');
    const e = node(['scripts/export-all-data.js', '--out', plain, '--no-checksum'], { DATABASE_URL: urlFor(SRC) });
    expect(e.status).toBe(0);
    const r = restore(plain, ['--wipe-target', '--confirm-target', where]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/the archive has no checksums, so the DATA itself was not compared/);
    expect(r.out).not.toMatch(/checksum matches/);
  }, 600000);

  test('a format-1 archive (the 7 Oct shape) loads, with its dates and NOT NULL JSON nulls put back', async () => {
    // Rebuild the archive the way the format-1 export wrote it: every value
    // through JSON.parse (so JSONB numbers already rewritten), every column
    // present (SQL NULL and JSON null both written as null), U+2028 raw, and
    // DATE values as local midnight on a machine at UTC+9 — east of
    // Greenwich, where taking the date part would be a day early.
    const legacy = path.join(tmp, 'legacy');
    fs.mkdirSync(legacy);
    const m = JSON.parse(fs.readFileSync(path.join(archive, '_manifest.json'), 'utf8'));
    for (const t of m.tables) {
      if (!t.file) continue;
      const names = t.columns.map((c) => c.name);
      const body = fs.readFileSync(path.join(archive, t.file), 'utf8').split('\n').filter(Boolean).map((l) => {
        const r = JSON.parse(l);
        const row = {};
        for (const n of names) row[n] = n in r ? r[n] : null;
        if (t.table === 'leads' && row.projected_sale_date) {
          row.projected_sale_date = new Date(Date.parse(row.projected_sale_date + 'T00:00:00.000Z') - 9 * 3600000).toISOString();
        }
        return JSON.stringify(row);
      }).join('\n') + '\n';
      fs.writeFileSync(path.join(legacy, t.file), body);
    }
    const v1 = {
      takenAt: m.takenAt, database: m.database, totalRows: m.totalRows, totalBytes: m.totalBytes,
      tables: m.tables.map((t) => ({ table: t.table, rows: t.rows, file: t.file, bytes: t.bytes })),
    };
    fs.writeFileSync(path.join(legacy, '_manifest.json'), JSON.stringify(v1, null, 2));
    expect(fs.readFileSync(path.join(legacy, 'organizations.jsonl'), 'utf8')).toContain(LS);

    const r = restore(legacy, ['--wipe-target', '--confirm-target', where]);
    expect(r.out).toMatch(/FORMAT 1/);
    expect(r.out).toMatch(/RESTORE CHECKS OUT/);
    expect(r.status).toBe(0);

    await withClient(DST, async (c) => {
      const { rows } = await c.query("SELECT id, projected_sale_date::text AS d FROM leads WHERE id LIKE 'lead-rt-%' ORDER BY id");
      expect(rows).toEqual([{ id: 'lead-rt-1', d: '2026-10-07' }, { id: 'lead-rt-2', d: '2028-02-29' }]);
      const { rows: [u] } = await c.query('SELECT notification_prefs::text AS p, name FROM users WHERE id = 501');
      expect(u).toEqual({ p: 'null', name: 'Para' + LS + 'graph' + PS });
    });
  }, 600000);

  test('for the record: what OFFSET paging over the tied rows returns', async () => {
    // Not an assertion about Postgres — whether ties come back in a stable
    // order is a plan detail that can change between versions and data
    // sizes. Logged so the report can say whether the old bug reproduced.
    const seen = await withClient(SRC, async (c) => {
      const keys = [];
      for (let off = 0; off < 12000; off += 5000) {
        // SELECT * so ORDER BY 1 is organization_id, exactly as the old export ran it.
        const { rows } = await c.query('SELECT * FROM bt_record_snapshots ORDER BY 1 LIMIT 5000 OFFSET $1', [off]);
        rows.forEach((x) => keys.push(x.dataset + '/' + x.bt_id));
      }
      return { fetched: keys.length, distinct: new Set(keys).size };
    });
    console.log('[round-trip] format-1 paging over 12,000 tied rows: fetched ' + seen.fetched + ', distinct ' + seen.distinct
      + (seen.distinct < seen.fetched ? ' — DUPLICATES/MISSES REPRODUCED' : ' — no duplicates on this run'));
    expect(seen.fetched).toBe(12000);
  });
});
