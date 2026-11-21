'use strict';

// scripts/export-r2-files.js — the parts that decide where each R2 object
// lands on disk and how the copy is proved. No network; the script's main()
// only runs when it is executed directly.

const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../scripts/export-r2-files');

describe('safeSegment — one key segment to a file name every OS accepts', () => {
  test('plain names pass through', () => {
    expect(R.safeSegment('att_1777438993364_9xo7t1_orig.jpg')).toBe('att_1777438993364_9xo7t1_orig.jpg');
  });
  test('characters Windows forbids are %-encoded, and % itself so nothing collides', () => {
    expect(R.safeSegment('a:b*c?d"e<f>g|h\\i')).toBe('a%3Ab%2Ac%3Fd%22e%3Cf%3Eg%7Ch%5Ci');
    expect(R.safeSegment('100%.pdf')).toBe('100%25.pdf');
    expect(R.safeSegment('tab\there')).toBe('tab%09here');
  });
  test('"." and ".." cannot climb out of the folder', () => {
    expect(R.safeSegment('..')).toBe('%2E%2E');
    expect(R.safeSegment('.')).toBe('%2E');
  });
  test('trailing dots and spaces (which Windows silently drops) are kept, encoded', () => {
    expect(R.safeSegment('report. ')).toBe('report%2E%20');
  });
  test('device names get a leading underscore', () => {
    expect(R.safeSegment('CON')).toBe('_CON');
    expect(R.safeSegment('nul.txt')).toBe('_nul.txt');
    expect(R.safeSegment('console.log')).toBe('console.log');
  });
  test('an empty segment (a // in the key) is named, not dropped', () => {
    expect(R.safeSegment('')).toBe('%EMPTY');
  });
});

describe('keyToRel', () => {
  test('keeps the key\'s folders', () => {
    expect(R.keyToRel('project/p1/att_1_orig.jpg', '/')).toBe('project/p1/att_1_orig.jpg');
  });
  test('a key built to escape stays inside the output folder', () => {
    const root = path.resolve(os.tmpdir(), 'p86-r2-root');
    const dest = path.resolve(root, R.keyToRel('../../windows/system32/evil.dll'));
    expect(dest.startsWith(root + path.sep)).toBe(true);
  });
});

describe('clashes — two keys, one file on a case-insensitive disk', () => {
  test('reported before anything downloads', () => {
    expect(R.clashes(['job/A.jpg', 'job/a.jpg', 'job/b.jpg'])).toEqual(['job/A.jpg  |  job/a.jpg']);
    expect(R.clashes(['x/1.jpg', 'x/2.jpg'])).toEqual([]);
  });
});

describe('plainMd5 — which ETags can prove the bytes', () => {
  test('a single-part ETag is an md5; a multipart one is not', () => {
    expect(R.plainMd5('9e107d9d372bb6826bd81d3542a419d6')).toBe(true);
    expect(R.plainMd5('9e107d9d372bb6826bd81d3542a419d6-3')).toBe(false);
    expect(R.plainMd5('')).toBe(false);
  });
});

describe('checkAgainst — the bucket vs. the attachments table in a DB archive', () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-r2-check-'));
    fs.writeFileSync(path.join(dir, 'attachments.jsonl'), [
      { id: 'a1', entity_type: 'job', entity_id: 'j1', original_key: 'job/j1/a1_orig.jpg', web_key: 'job/j1/a1_web.jpg', thumb_key: null },
      { id: 'a2', entity_type: 'estimate', entity_id: 'e1', original_key: 'estimate/e1/a2_orig.pdf' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('counts references, lists the missing ones, and sizes the unreferenced', () => {
    const c = R.checkAgainst(dir, ['job/j1/a1_orig.jpg', 'job/j1/a1_web.jpg', 'chat_outputs/x.txt']);
    expect(c.attachments).toBe(2);
    expect(c.references).toBe(3);
    expect(c.present).toBe(2);
    expect(c.missing).toEqual([{ attachment: 'a2', column: 'original_key', key: 'estimate/e1/a2_orig.pdf', entity: 'estimate e1' }]);
    expect(c.unreferencedByPrefix).toEqual({ chat_outputs: 1 });
  });
  test('says so when the archive has no attachments table', () => {
    expect(R.checkAgainst(os.tmpdir() + '/definitely-not-an-archive', []).error).toMatch(/no attachments\.jsonl/);
  });
});

describe('the script keeps its promises', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'export-r2-files.js'), 'utf8');
  test('read only: lists and gets, never puts or deletes', () => {
    expect(src).not.toMatch(/PutObject|DeleteObject|CopyObject|CreateMultipartUpload/);
  });
  test('a download only becomes the file after its size and md5 check out', () => {
    const check = src.indexOf("throw new Error('md5 '");
    const rename = src.indexOf('fs.renameSync(tmp, file)');
    expect(check).toBeGreaterThan(0);
    expect(rename).toBeGreaterThan(check);
  });
  test('the manifest is written after every download has finished', () => {
    expect(src.indexOf("'_manifest.json'")).toBeGreaterThan(src.indexOf('await Promise.all(Array.from({ length: CONCURRENCY }, worker))'));
  });
});
