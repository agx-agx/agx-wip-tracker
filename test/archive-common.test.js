'use strict';

// scripts/archive-common.js is the contract between export-all-data.js and
// restore-all-data.js. Everything here runs without a database; the
// end-to-end proof (export -> restore -> identical checksums) is
// test/archive-round-trip.test.js, which needs a scratch Postgres.

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../scripts/archive-common');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'scripts', f), 'utf8');
const LS = String.fromCharCode(0x2028);   // built, not typed: a raw U+2028 in source is a line break
const PS = String.fromCharCode(0x2029);

describe('identifiers', () => {
  test('quotes plain catalogue names', () => {
    expect(A.q('bt_record_snapshots')).toBe('"bt_record_snapshots"');
  });
  test('refuses anything that is not a plain identifier', () => {
    expect(() => A.q('users; DROP TABLE users')).toThrow(/refusing identifier/);
    expect(() => A.q('a"b')).toThrow();
    expect(() => A.q('')).toThrow();
  });
});

describe('checksumSql', () => {
  const sql = A.checksumSql('jobs', ['zeta', 'id', 'alpha']);

  test('names the columns in sorted order, so column POSITION cannot change the sum', () => {
    expect(sql).toContain('ROW(t."alpha", t."id", t."zeta")::text');
    expect(A.checksumSql('jobs', ['id', 'zeta', 'alpha'])).toBe(sql);
  });
  test('sorts with COLLATE "C", so the database locale cannot change the sum', () => {
    expect(sql).toContain('ORDER BY h COLLATE "C"');
  });
  test('hashes each row first, so the aggregate grows 32 bytes a row and cannot hit the 1 GiB text limit', () => {
    expect(sql).toContain('SELECT md5(ROW(');
    expect(A.CHECKSUM_ALGO).toBe('md5-sorted-rowmd5-v2');
  });
  test('counts in the same statement it sums', () => {
    expect(sql).toMatch(/^SELECT COUNT\(\*\)::bigint AS n, md5\(/);
  });
  test('refuses a table with no columns rather than summing nothing', () => {
    expect(() => A.checksumSql('t', [])).toThrow();
  });
});

describe('encodeRow — what export writes', () => {
  test('a bytea Buffer becomes { __bytea: base64 }', () => {
    const line = A.encodeRow({ id: 1, blob: Buffer.from('hi') });
    expect(JSON.parse(line)).toEqual({ id: 1, blob: { __bytea: 'aGk=' } });
  });
  test('the format-1 replacer really did miss Buffers (why this changed)', () => {
    const old = JSON.stringify({ b: Buffer.from('hi') },
      (k, v) => (Buffer.isBuffer(v) ? { __bytea: v.toString('base64') } : v));
    expect(JSON.parse(old).b).toEqual({ type: 'Buffer', data: [104, 105] });
  });
  test('JSONB text from Postgres is spliced in verbatim, so its numbers survive', () => {
    const row = { id: 7, data: '{"amount": 12.50, "big": 9007199254740993, "n": 3.0}', note: 'x' };
    const line = A.encodeRow(row, new Set(['data']));
    expect(line).toBe('{"id":7,"data":{"amount": 12.50, "big": 9007199254740993, "n": 3.0},"note":"x"}');
    // ...which JSON.parse would have rewritten, the format-1 loss:
    expect(JSON.stringify(JSON.parse(row.data))).toBe('{"amount":12.5,"big":9007199254740992,"n":3}');
  });
  test('an SQL NULL in a jsonb column leaves the key out; a JSON null is spliced as null', () => {
    expect(A.encodeRow({ id: 1, data: null }, new Set(['data']))).toBe('{"id":1}');
    expect(A.encodeRow({ id: 1, data: 'null' }, new Set(['data']))).toBe('{"id":1,"data":null}');
  });
  test('only jsonb is spliced; json, floats and numeric[] are kept as text', () => {
    expect([...A.JSON_OIDS]).toEqual([3802]);
    for (const oid of [114, 3802, 700, 701, 1021, 1022, 1231]) expect(A.KEEP_AS_TEXT_OIDS.has(oid)).toBe(true);
  });
  test('U+2028 and U+2029 are escaped, in plain and in spliced values, and parse back unchanged', () => {
    const line = A.encodeRow({ a: 'x' + LS + 'y', j: '{"k": "p' + PS + 'q"}' }, new Set(['j']));
    expect(line).not.toContain(LS);
    expect(line).not.toContain(PS);
    const back = JSON.parse(line);
    expect(back.a).toBe('x' + LS + 'y');
    expect(back.j.k).toBe('p' + PS + 'q');
    expect(A.encodeRow({ a: LS })).toBe('{"a":"\\u2028"}');
  });
  test('everything else passes through untouched', () => {
    const row = { id: '9007199254740993', amount: '12.50', when: '2026-10-07 12:00:00.123456+00', data: { a: [1, 'é', null] } };
    expect(JSON.parse(A.encodeRow(row))).toEqual(row);
  });
});

describe('jsonlLines — the restore\'s reader', () => {
  test('splits on \\n only: a raw U+2028 inside a string stays inside its row, and CRLF is tolerated', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-jsonl-'));
    try {
      const file = path.join(dir, 't.jsonl');
      fs.writeFileSync(file, '{"a":"one' + LS + 'two' + PS + '"}\r\n{"a":"b"}\n{"a":"c"}');
      const lines = [];
      for await (const l of A.jsonlLines(file)) lines.push(JSON.parse(l).a);
      expect(lines).toEqual(['one' + LS + 'two' + PS, 'b', 'c']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('legacyDateValue — DATE values from a format-1 archive', () => {
  // '2026-10-07' exported on a machine at offset X arrived as local midnight in UTC.
  const exportedAt = (offsetHours) => new Date(Date.UTC(2026, 9, 7) - offsetHours * 3600000).toISOString();

  test.each([-10, -7, -5, -4, 0, 1, 2, 5.5, 9, 11])('offset %s h comes back as 2026-10-07', (h) => {
    expect(A.legacyDateValue(exportedAt(h))).toBe('2026-10-07');
  });
  test('taking the date part instead would have been a day early east of Greenwich', () => {
    expect(exportedAt(2).slice(0, 10)).toBe('2026-10-06');
  });
  test('a plain date, null, and non-date strings are left alone', () => {
    expect(A.legacyDateValue('2026-10-07')).toBe('2026-10-07');
    expect(A.legacyDateValue(null)).toBe(null);
    expect(A.legacyDateValue('not a date')).toBe('not a date');
  });
});

describe('decodeRow — what restore loads from a format-1 archive', () => {
  const types = {
    blob: { base: 'bytea', isArray: false },
    blobs: { base: 'bytea', isArray: true },
    due: { base: 'date', isArray: false },
    data: { base: 'jsonb', isArray: false },
  };

  test('bytea in both spellings becomes \\x hex', () => {
    const out = A.decodeRow({ blob: { __bytea: 'aGk=' }, blobs: [{ type: 'Buffer', data: [104, 105] }] }, types, false);
    expect(out.blob).toBe('\\x6869');
    expect(out.blobs).toEqual(['\\x6869']);
  });
  test('a jsonb value that happens to have a __bytea key is NOT decoded', () => {
    const data = { __bytea: 'aGk=' };
    expect(A.decodeRow({ data }, types, false).data).toEqual(data);
  });
  test('dates are converted only for a legacy archive', () => {
    const v = '2026-10-07T04:00:00.000Z';
    expect(A.decodeRow({ due: v }, types, true).due).toBe('2026-10-07');
    expect(A.decodeRow({ due: '2026-10-07' }, types, false).due).toBe('2026-10-07');
  });
});

describe('refuseTarget — the cheap guard before connecting', () => {
  const prod = 'postgresql://postgres:secret@monorail.proxy.rlwy.net:41234/railway';

  test('requires RESTORE_DATABASE_URL', () => {
    expect(A.refuseTarget('', {})).toMatch(/not set/);
  });
  test('refuses a non-postgres URL', () => {
    expect(A.refuseTarget('mysql://x/y', {})).toMatch(/postgres/);
  });
  test('refuses the database the app uses, whatever the password or params say', () => {
    const same = 'postgres://other:pw@MONORAIL.proxy.rlwy.net:41234/railway?sslmode=no-verify';
    expect(A.refuseTarget(same, { DATABASE_URL: prod })).toMatch(/same database as DATABASE_URL/);
    expect(A.refuseTarget(same, { DATABASE_PUBLIC_URL: prod })).toMatch(/DATABASE_PUBLIC_URL/);
  });
  test('refuses a Railway internal host', () => {
    expect(A.refuseTarget('postgresql://u:p@postgres.railway.internal:5432/railway', {})).toMatch(/internal/);
  });
  test('allows a different database on the same server', () => {
    expect(A.refuseTarget('postgresql://postgres:secret@monorail.proxy.rlwy.net:41234/scratch', { DATABASE_URL: prod })).toBe(null);
  });
  test('reads the URL the way pg does: ?host=, IPv6 brackets, trailing dot, missing database', () => {
    expect(A.dbIdentity('postgres://u@decoy/db?host=REAL.example.com').host).toBe('real.example.com');
    expect(A.dbIdentity('postgresql://u@[::1]:5432/db').host).toBe('::1');
    expect(A.dbIdentity('postgresql://u@db.example.com.:5432/x').host).toBe('db.example.com');
    expect(A.dbIdentity('postgresql://postgres@localhost').database).toBe('postgres');
    expect(A.refuseTarget('postgres://u@decoy/x?host=postgres.railway.internal', {})).toMatch(/internal/);
  });
  test('the wipe confirmation names the server, not just the database', () => {
    expect(A.targetLabel('postgresql://u:p@monorail.proxy.rlwy.net:41234/railway', 'railway'))
      .toBe('monorail.proxy.rlwy.net:41234/railway');
  });
  test('default port counts as 5432', () => {
    expect(A.sameDatabase('postgresql://localhost/a', 'postgresql://u@localhost:5432/a')).toBe(true);
  });
});

describe('topoOrder — parent-first loading without a superuser', () => {
  test('parents come before children; self-references do not block', () => {
    const { order, cyclic } = A.topoOrder(['line', 'job', 'org', 'folder'], [
      { child: 'job', parent: 'org' },
      { child: 'line', parent: 'job' },
      { child: 'folder', parent: 'folder' },
    ]);
    expect(cyclic).toEqual([]);
    expect(order.indexOf('org')).toBeLessThan(order.indexOf('job'));
    expect(order.indexOf('job')).toBeLessThan(order.indexOf('line'));
    expect(order).toContain('folder');
  });
  test('reports a cycle instead of guessing', () => {
    const { cyclic } = A.topoOrder(['a', 'b', 'c'], [{ child: 'a', parent: 'b' }, { child: 'b', parent: 'a' }]);
    expect(cyclic.sort()).toEqual(['a', 'b']);
  });
});

describe('splitSql — applying init()\'s script one statement at a time', () => {
  test('splits on top-level semicolons only', () => {
    const sql = `
      CREATE TABLE a (id INT); -- trailing; comment
      /* block; with /* nested; */ comment */
      INSERT INTO a VALUES (1), (2);
      UPDATE a SET note = 'it''s; fine', e = E'back\\'slash;' WHERE "odd;name" = 1;
      DO $blk$ BEGIN PERFORM 1; PERFORM 2; END $blk$;
      CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;
      SELECT $1::int;
      -- only a comment;
    `;
    const s = A.splitSql(sql);
    // Six statements; comments travel with the statement after them, and the
    // comment-only tail is dropped.
    expect(s).toHaveLength(6);
    expect(s[0]).toBe('CREATE TABLE a (id INT)');
    expect(s[1]).toMatch(/INSERT INTO a VALUES \(1\), \(2\)$/);
    expect(s[2]).toContain("'it''s; fine'");
    expect(s[2]).toContain("E'back\\'slash;'");   // an escaped quote inside E'' does not end the string
    expect(s[2]).toContain('"odd;name" = 1');
    expect(s[3]).toBe('DO $blk$ BEGIN PERFORM 1; PERFORM 2; END $blk$');
    expect(s[4]).toContain('$$ SELECT 1; $$');
    expect(s[5]).toBe('SELECT $1::int');
  });
  test('splits the real initSchema script into whole statements', () => {
    // CRLF-normalised: on a Windows checkout the anchor below would not match.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8').replace(/\r\n/g, '\n');
    const anchor = 'async function initSchema() {\n  await pool.query(`';
    const at = src.indexOf(anchor);
    expect(at).toBeGreaterThan(0);
    const start = at + anchor.length;
    const text = src.slice(start, src.indexOf('`);', start));
    expect(text.length).toBeGreaterThan(100000);
    const s = A.splitSql(text);
    expect(s[0]).toMatch(/^CREATE TABLE IF NOT EXISTS users/);
    const creates = s.filter((x) => /^(?:--[^\n]*\n\s*)*CREATE TABLE IF NOT EXISTS/i.test(x));
    expect(creates.length).toBeGreaterThan(100);
    // every dollar-quoted body is closed inside the statement that opened it
    for (const x of s) {
      const tags = x.match(/\$[A-Za-z_]*\$/g) || [];
      expect(tags.length % 2).toBe(0);
    }
  });
});

describe('textDateTypes', () => {
  const fake = { getTypeParser: () => 'default' };
  test('date, time, json and float types come back as the text Postgres sent', () => {
    const t = A.textDateTypes(fake);
    for (const oid of [1082, 1184, 1114, 1185, 3802, 701]) expect(t.getTypeParser(oid, 'text')('x')).toBe('x');
  });
  test('everything else uses the normal parser', () => {
    expect(A.textDateTypes(fake).getTypeParser(23, 'text')).toBe('default');
  });
});

describe('the scripts keep their promises', () => {
  const exp = read('export-all-data.js');
  const res = read('restore-all-data.js');
  // String literals only, comments removed first: the header comment quotes
  // the old `ORDER BY 1 LIMIT 5000 OFFSET n` on purpose.
  const sqlStrings = (src) => (src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    .match(/'[^'\n]*'|`[^`]*`/g) || []).join('\n');

  test('export reads everything from one READ ONLY snapshot', () => {
    expect(exp).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  });
  test('export pages with a cursor, never LIMIT/OFFSET', () => {
    expect(exp).toMatch(/DECLARE p86_export NO SCROLL CURSOR FOR SELECT \* FROM/);
    expect(sqlStrings(exp)).not.toMatch(/\bOFFSET\b/);
  });
  test('export keeps date/time/json values as text', () => {
    expect(exp).toContain('types: A.textDateTypes(pg.types)');
  });
  test('export gets out of a deploy\'s way between batches', () => {
    expect(exp).toContain('FROM pg_locks');
    expect(exp).toContain('pg_backend_pid() = ANY(pg_blocking_pids(pid))');
    expect((exp.match(/await stopIfBlockingOthers\(client\)/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  test('restore takes its target ONLY from RESTORE_DATABASE_URL', () => {
    expect(res).toContain("const target = process.env.RESTORE_DATABASE_URL || '';");
    expect(res).not.toMatch(/process\.env\.DATABASE_URL\s*=/);
    expect(res).not.toMatch(/connectionString:\s*process\.env\.DATABASE/);
  });
  test('restore checks the target before writing to it', () => {
    // Call sites in main(), not the function definitions above it. Each must
    // EXIST, or indexOf's -1 would pass the ordering checks trivially.
    const build = res.indexOf('    buildSchema(target);');
    const refuse = res.indexOf('A.refuseTarget(target, process.env)');
    const total = res.indexOf('await rowTotal(client)');
    for (const at of [build, refuse, total]) expect(at).toBeGreaterThan(0);
    expect(refuse).toBeLessThan(build);
    expect(total).toBeLessThan(build);
    expect(res).toContain('if (refusal) fail(refusal);');
    expect(res).toContain('CONFIRM_TARGET !== where');
  });
  test('restore reads JSONL with its own splitter, not readline', () => {
    expect(res).not.toMatch(/require\('readline'\)/);
    expect(res).toContain('A.jsonlLines(file)');
  });
  test('restore never cascades its TRUNCATE into tables outside public', () => {
    expect(res).toContain("'TRUNCATE TABLE ' + all + ' RESTART IDENTITY'");
    expect(res).not.toMatch(/RESTART IDENTITY CASCADE/);
  });
  test('no script holds a raw U+2028/U+2029 (each is a line break to JavaScript)', () => {
    for (const f of ['archive-common.js', 'export-all-data.js', 'restore-all-data.js', 'restore-build-schema.js']) {
      const src = read(f);
      expect(src.includes(LS) || src.includes(PS)).toBe(false);
    }
  });
});
