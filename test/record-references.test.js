'use strict';
// The reference registry (server/services/record-references.js) is pinned to
// the schema: every column in server/db.js that points at a job, lead or
// client is moved by a merge or deliberately not, with the reason.

const { tableColumns, hasTable } = require('./helpers/db-schema');
const refs = require('../server/services/record-references');

describe('the reference registry is pinned to the schema', () => {
  test('every column in server/db.js that points at a job, lead or client is moved or deliberately not', () => {
    const { tables } = tableColumns();
    const moved = new Set();
    for (const kind of Object.keys(refs.PLAIN)) for (const r of refs.PLAIN[kind]) moved.add(r.table + '.' + r.col);
    const poly = new Set(refs.POLYMORPHIC);
    const missing = [];
    for (const [table, cols] of tables) {
      for (const col of cols.keys()) {
        const key = table + '.' + col;
        const isRef = ['job_id', 'lead_id', 'client_id', 'parent_client_id'].includes(col);
        const isPoly = col === 'entity_id' && cols.has('entity_type');
        if (!isRef && !isPoly) continue;
        if (moved.has(key) || refs.NOT_MOVED[key] || (isPoly && poly.has(table))) continue;
        missing.push(key);
      }
    }
    // Tables this reconcile deliberately leaves alone because they are not about
    // a job/lead/client record at all are listed here, each with its reason.
    const OUT_OF_SCOPE = {
      'job_reports.entity_id': 'moved as polymorphic (job_reports is in POLYMORPHIC)',
    };
    expect(missing.filter((k) => !OUT_OF_SCOPE[k])).toEqual([]);
    for (const k of moved) expect(hasTable(k.split('.')[0])).toBe(true);
    for (const t of poly) expect(hasTable(t)).toBe(true);
  });
});
