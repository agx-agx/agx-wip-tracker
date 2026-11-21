#!/usr/bin/env node
'use strict';

/**
 * restore-build-schema.js — build the Project 86 schema on an EMPTY database.
 * Run only by restore-all-data.js (and the round-trip test), in a child
 * process whose DATABASE_URL is the scratch target. It refuses to run
 * otherwise.
 *
 * WHY THIS IS NOT JUST `require('../server/db').init()`
 * Because init() cannot build the schema from nothing. Its first query is one
 * multi-statement script (server/db.js initSchema, ~6,500 lines) that has
 * grown by appending, and it now touches about 60 tables BEFORE the statement
 * that creates them — the multi-tenant block (ALTER TABLE estimates / leads /
 * clients / attachments ... ADD COLUMN organization_id, and the backfills
 * after it) sits above CREATE TABLE estimates, and the May skill-pack
 * migration reads app_settings above CREATE TABLE app_settings. Production
 * never notices: its tables already exist, so every one of those statements
 * finds its table. On an empty database the first one fails, the whole
 * script rolls back (a multi-statement query is one implicit transaction),
 * init() rejects and the app exits. Measured 2026-10-16 on Postgres 18.4.
 *
 * That makes it a disaster-recovery bug in its own right — P86 cannot boot
 * onto a new database today — and fixing it means reordering production's
 * boot migration, which is its own reviewed change. This file does not touch
 * that code. It runs init() unchanged and, ONLY when a multi-statement query
 * fails because something it refers to does not exist yet, re-runs that
 * query's statements one at a time, deferring each one that is still
 * missing something until a later pass, until all of them have applied. A
 * statement that fails for any other reason stops the build.
 *
 * Statement order changes only within that fallback, and only on an empty
 * database, where the backfill UPDATEs and seed INSERTs touch no data that
 * the restore keeps — restore-all-data.js truncates every table before it
 * loads the archive. What it needs from this is the SHAPE: every table and
 * column the archive has, which it then checks for explicitly.
 */

if (process.env.P86_RESTORE_CHILD !== '1') {
  console.error('restore-build-schema.js is run by restore-all-data.js, not by hand.');
  process.exit(2);
}

const A = require('./archive-common');
const db = require('../server/db');

/* "Something this refers to does not exist yet": table, column, other object
 * (index, constraint, type), function, an ON CONFLICT target whose unique
 * index comes later, and a REFERENCES column whose unique key comes later. */
const NOT_YET = new Set(['42P01', '42703', '42704', '42883', '42P10', '42830']);

const original = db.pool.query.bind(db.pool);

db.pool.query = async function (text, ...rest) {
  try {
    return await original(text, ...rest);
  } catch (e) {
    if (typeof text !== 'string' || rest.length || !NOT_YET.has(e.code)) throw e;
    const statements = A.splitSql(text);
    if (statements.length < 2) throw e;

    console.log('[restore] init() query of ' + statements.length + ' statements failed on the empty database ('
      + e.message + '); applying it statement by statement.');
    let pending = statements;
    let pass = 0;
    while (pending.length) {
      pass++;
      const deferred = [];
      for (const s of pending) {
        try {
          await original(s);
        } catch (err) {
          if (!NOT_YET.has(err.code)) {
            console.log('[restore] gave up: a statement failed for a reason other than a missing object (' + err.message + ').');
            err.message += '\n  in statement: ' + s.slice(0, 400);
            throw err;
          }
          deferred.push({ s, err });
        }
      }
      if (deferred.length === pending.length) {
        const first = deferred[0];
        console.log('[restore] gave up: none of the ' + deferred.length + ' remaining statement(s) could apply ('
          + first.err.message + ').');
        first.err.message = 'no progress after ' + pass + ' passes, ' + deferred.length
          + ' statement(s) still missing something. First: ' + first.err.message + '\n  in statement: ' + first.s.slice(0, 400);
        throw first.err;
      }
      pending = deferred.map((x) => x.s);
    }
    console.log('[restore] applied all ' + statements.length + ' statements in ' + pass + ' passes.');
    return { rows: [], rowCount: 0, command: 'MULTI' };
  }
};

db.init()
  .then(() => process.exit(0))
  .catch((e) => { console.error('[restore] building the schema failed: ' + (e && (e.stack || e.message))); process.exit(1); });
