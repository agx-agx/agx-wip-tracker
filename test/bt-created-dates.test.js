/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * A SYNCED RECORD'S AGE IS BUILDERTREND'S, NOT THE IMPORT'S.
 *
 * created_at on an imported row is the instant of the sync. Measured on the
 * live org: 609 of 687 jobs carried 2026-09-25, because that is the day the
 * big import ran. Sorting by age ranked records by when we fetched them.
 *
 * Buildertrend sends the real date (jobs.createdDate: non-empty on all 729
 * records, 729 distinct values), and the sync stored it in bt_created_at.
 * The sync itself was removed on 11/26/2026; the columns and the lists that
 * read them stay.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('the columns', () => {
  test('the columns exist, on both tables', () => {
    const db = read('server/db.js');
    for (const tbl of ['jobs', 'leads']) {
      expect(db).toMatch(new RegExp('ALTER TABLE ' + tbl + '\\s+ADD COLUMN IF NOT EXISTS bt_created_at TIMESTAMPTZ;'));
      expect(db).toMatch(new RegExp('ALTER TABLE ' + tbl + '\\s+ADD COLUMN IF NOT EXISTS bt_synced_at\\s+TIMESTAMPTZ;'));
    }
  });
});

describe('what a list shows and sorts on', () => {
  let B;
  beforeAll(() => {
    window.eval(read('js/bt-badge.js'));
    B = window.p86BtBadge;
  });

  test('Buildertrend’s date wins when we have it', () => {
    expect(B.createdInstant({ bt_created_at: '2023-05-11T00:00:00Z', created_at: '2026-09-25T12:13:34Z' }))
      .toBe('2023-05-11T00:00:00Z');
  });

  test('a record made in Project 86 keeps its own date', () => {
    // The fallback is not cosmetic: without it, every P86-born record would
    // have no date at all and the two kinds could not sort in one list.
    expect(B.createdInstant({ created_at: '2026-01-04T00:00:00Z' })).toBe('2026-01-04T00:00:00Z');
  });

  test('a record synced before the columns existed still shows a date', () => {
    // It falls back until the next sync heals it — it must not go blank.
    expect(B.createdInstant({ bt_job_id: '1', created_at: '2026-09-25T12:13:34Z' }))
      .toBe('2026-09-25T12:13:34Z');
  });

  test('synced-at is null when nothing was ever synced, not the creation date', () => {
    expect(B.syncedInstant({ created_at: '2026-01-04T00:00:00Z' })).toBeNull();
    expect(B.syncedInstant({ bt_synced_at: '2026-09-25T12:00:00Z' })).toBe('2026-09-25T12:00:00Z');
  });

  test('an unknown date sorts LAST, not as 1970', () => {
    expect(B.createdSortKey({ bt_created_at: '2023-05-11T00:00:00Z' })).toBe(Date.parse('2023-05-11T00:00:00Z'));
    expect(B.createdSortKey({})).toBeNull();
    expect(B.createdSortKey({ created_at: 'nonsense' })).toBeNull();
  });

  test('the real ordering: imported records spread out instead of clumping', () => {
    // Three leads that all arrived in one sync, with three different
    // Buildertrend dates. Sorted on created_at alone they are indistinguishable.
    const synced = '2026-09-25T12:00:00Z';
    const leads = [
      { id: 'c', bt_created_at: '2025-02-01T00:00:00Z', created_at: synced },
      { id: 'a', bt_created_at: '2023-01-01T00:00:00Z', created_at: synced },
      { id: 'b', bt_created_at: '2024-06-15T00:00:00Z', created_at: synced },
      { id: 'd', created_at: '2026-03-03T00:00:00Z' },   // born here
    ];
    const order = leads.slice().sort((x, y) => {
      const a = B.createdSortKey(x), b = B.createdSortKey(y);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    }).map((l) => l.id);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    // and on the raw column they would not have sorted at all
    const raw = new Set(leads.slice(0, 3).map((l) => l.created_at));
    expect(raw.size).toBe(1);
  });
});
