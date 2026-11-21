#!/usr/bin/env node
'use strict';

/**
 * export-r2-files.js — download every uploaded file out of Cloudflare R2, and
 * prove each copy.
 *
 * WHY THIS EXISTS
 * The database stores only URLs and keys. The actual bytes of every photo,
 * plan, PDF, receipt and thumbnail live in an R2 bucket, and there is no
 * second copy of them anywhere. A database export alone preserves the records
 * and loses everything the records point at. This is the other half of OPS-1
 * (export-all-data.js is the database half).
 *
 * Two buckets exist on this account: project86-attachments (current) and
 * agx-attachments (older — the migration at server/db.js rewrote URLs from
 * attachments.wip-agxco.com to attachments.project86.net, so the older bucket
 * may still hold files the app no longer references). Export both.
 *
 * READ ONLY: the only R2 calls are ListObjectsV2 and GetObject.
 *
 * USAGE — credentials come from the environment, never the command line. The
 * simplest way is to let Railway inject the project86 service's own R2_*
 * variables (add --project <id> --environment production when the directory
 * is not linked; on Windows keep pipes out of railway run's arguments, it
 * hands the line to cmd.exe):
 *
 *   railway run --service project86 -- node scripts/export-r2-files.js --list-only
 *   railway run --service project86 -- node scripts/export-r2-files.js --out D:/p86-files-2026-11-21
 *   railway run --service project86 -- node scripts/export-r2-files.js --bucket agx-attachments --out D:/p86-files-old
 *
 *   --bucket <name>          default: R2_BUCKET, else project86-attachments
 *   --out <dir>              default: ./r2-<bucket>
 *   --list-only              list and size the bucket, download nothing
 *   --check-against <dir>    compare with an export-all-data.js archive
 *   --concurrency <n>        parallel downloads, default 6
 *
 * WHAT IT GUARANTEES
 *   - every object is written to <out>/files/<key> through a .part file that
 *     is renamed only once its byte count matches the listing and its md5
 *     matches the ETag (R2 gives a plain md5 ETag for single-part uploads;
 *     multipart objects are checked by size only, and the manifest says which);
 *   - keys are mapped to safe Windows paths (forbidden characters %-encoded,
 *     device names prefixed, "." and ".." encoded so nothing climbs out), and
 *     two keys that would land on the same file stop the run before any
 *     download;
 *   - re-running resumes: a file already on disk with the right size AND md5
 *     is kept, not downloaded again;
 *   - _manifest.json (key -> file, size, ETag, md5) is written LAST. A folder
 *     without one is not a finished backup.
 *
 * --check-against compares the bucket with the attachments table in a
 * database archive: every original/web/thumb key a row points at should be
 * in the bucket. Missing ones were already gone from R2 when this ran; the
 * report lists them so they are not mistaken for a backup failure.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const enc = (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');

/* One segment of an object key -> a name Windows (and everything else)
 * accepts. '%' is encoded too, so an encoded name never collides with a real
 * one, and the manifest keeps the exact key beside every file. */
function safeSegment(s) {
  if (s === '') return '%EMPTY';
  if (s === '.' || s === '..') return s.replace(/\./g, '%2E');
  let o = s.replace(/[<>:"\\|?*\x00-\x1f%]/g, enc);
  o = o.replace(/[. ]+$/, (m) => m.split('').map(enc).join(''));
  if (RESERVED.test(o)) o = '_' + o;
  return o;
}
const keyToRel = (key, sep = path.sep) => key.split('/').map(safeSegment).join(sep);
const plainMd5 = (etag) => /^[0-9a-f]{32}$/.test(etag);

const human = (n) => (n < 1024 ? n + ' B'
  : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
  : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB'
  : (n / 1073741824).toFixed(2) + ' GB');

/* Keys that would be the same file on a case-insensitive disk. */
function clashes(keys) {
  const seen = new Map();
  const out = [];
  for (const k of keys) {
    const rel = keyToRel(k, '/').toLowerCase();
    if (seen.has(rel)) out.push(seen.get(rel) + '  |  ' + k);
    seen.set(rel, k);
  }
  return out;
}

/* Files the attachments table points at vs. the keys in the bucket. */
function checkAgainst(dbDir, keys) {
  const file = path.join(dbDir, 'attachments.jsonl');
  if (!fs.existsSync(file)) return { error: 'no attachments.jsonl in ' + dbDir };
  const have = new Set(keys);
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map(JSON.parse);
  const referenced = new Set();
  const missing = [];
  let refs = 0;
  for (const r of rows) {
    for (const col of ['original_key', 'web_key', 'thumb_key']) {
      const k = r[col];
      if (!k) continue;
      refs++;
      referenced.add(k);
      if (!have.has(k)) {
        missing.push({ attachment: r.id, column: col, key: k, entity: ((r.entity_type || '') + ' ' + (r.entity_id || '')).trim() });
      }
    }
  }
  const unreferencedByPrefix = {};
  for (const k of have) {
    if (referenced.has(k)) continue;
    const p = k.split('/')[0];
    unreferencedByPrefix[p] = (unreferencedByPrefix[p] || 0) + 1;
  }
  return { attachments: rows.length, references: refs, present: refs - missing.length, missing, unreferencedByPrefix };
}

async function main() {
  const ARGV = process.argv.slice(2);
  const arg = (n) => {
    const i = ARGV.indexOf(n);
    return i !== -1 && ARGV[i + 1] && !ARGV[i + 1].startsWith('--') ? ARGV[i + 1] : null;
  };
  const LIST_ONLY = ARGV.includes('--list-only') || ARGV.includes('--count-only');
  const BUCKET = arg('--bucket') || process.env.R2_BUCKET || 'project86-attachments';
  const OUT = path.resolve(arg('--out') || path.join(process.cwd(), 'r2-' + BUCKET));
  const CHECK = arg('--check-against');
  const CONCURRENCY = Math.max(1, Number(arg('--concurrency')) || 6);

  const ACCOUNT = process.env.R2_ACCOUNT_ID || '';
  const KEY = process.env.R2_ACCESS_KEY_ID || '';
  const SECRET = process.env.R2_SECRET_ACCESS_KEY || '';
  if (!ACCOUNT || !KEY || !SECRET) {
    console.error('\nSet R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY first — easiest is');
    console.error('  railway run --service project86 -- node scripts/export-r2-files.js ...\n');
    process.exitCode = 2;
    return;
  }

  const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({
    region: 'auto',   // R2 ignores region but the SDK demands one (server/storage.js does the same)
    endpoint: 'https://' + ACCOUNT + '.r2.cloudflarestorage.com',
    credentials: { accessKeyId: KEY, secretAccessKey: SECRET },
  });

  const t0 = Date.now();
  const objects = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token, MaxKeys: 1000 }));
    for (const o of r.Contents || []) {
      objects.push({ key: o.Key, size: Number(o.Size) || 0, etag: String(o.ETag || '').replace(/"/g, ''),
        lastModified: o.LastModified ? o.LastModified.toISOString() : null });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  const total = objects.reduce((n, o) => n + o.size, 0);
  console.log('\nbucket ' + BUCKET + ': ' + objects.length + ' objects, ' + human(total));
  const byPrefix = new Map();
  for (const o of objects) {
    const p = o.key.includes('/') ? o.key.split('/')[0] : '(top level)';
    const e = byPrefix.get(p) || { n: 0, bytes: 0 };
    e.n++; e.bytes += o.size;
    byPrefix.set(p, e);
  }
  [...byPrefix.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 12)
    .forEach(([p, v]) => console.log('  ' + String(v.n).padStart(7) + '  ' + human(v.bytes).padStart(10) + '  ' + p));
  console.log('  ' + objects.filter((o) => !plainMd5(o.etag)).length + ' object(s) have a multipart ETag (checked by size only)');

  if (LIST_ONLY) {
    if (CHECK) {
      const c = checkAgainst(CHECK, objects.map((o) => o.key));
      console.log('\nattachments table: ' + (c.error || (c.present + ' of ' + c.references + ' file references are in this bucket')));
    }
    console.log('\n--list-only: nothing downloaded.\n');
    return;
  }

  const clash = clashes(objects.map((o) => o.key));
  if (clash.length) {
    console.error('\nSTOPPED before downloading: these keys would land on the same file:');
    clash.forEach((c) => console.error('  ' + c));
    process.exitCode = 1;
    return;
  }

  const root = path.join(OUT, 'files');
  fs.mkdirSync(root, { recursive: true });
  console.log('\nwriting to ' + OUT + '\n');

  async function md5File(file) {
    const h = crypto.createHash('md5');
    await pipeline(fs.createReadStream(file), h);
    return h.digest('hex');
  }

  async function fetchOne(o) {
    const rel = keyToRel(o.key);
    const file = path.join(root, rel);
    if (fs.existsSync(file) && fs.statSync(file).size === o.size) {
      const md5 = await md5File(file);
      if (!plainMd5(o.etag) || md5 === o.etag) return { rel, md5, reused: true };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.part';
    const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: o.key }));
    const h = crypto.createHash('md5');
    let n = 0;
    const tap = new Transform({ transform(chunk, _e, cb) { h.update(chunk); n += chunk.length; cb(null, chunk); } });
    await pipeline(r.Body, tap, fs.createWriteStream(tmp));
    const md5 = h.digest('hex');
    if (n !== o.size) throw new Error('received ' + n + ' bytes, the listing says ' + o.size);
    if (plainMd5(o.etag) && md5 !== o.etag) throw new Error('md5 ' + md5 + ' does not match the ETag ' + o.etag);
    fs.renameSync(tmp, file);
    return { rel, md5, reused: false };
  }

  const entries = new Array(objects.length);
  const problems = [];
  let next = 0; let finished = 0; let bytes = 0; let reused = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= objects.length) return;
      const o = objects[i];
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetchOne(o);
          entries[i] = { key: o.key, file: ['files'].concat(r.rel.split(path.sep)).join('/'), size: o.size, etag: o.etag,
            md5: r.md5, lastModified: o.lastModified, verified: plainMd5(o.etag) ? 'md5' : 'size' };
          if (r.reused) reused++;
          lastErr = null;
          break;
        } catch (e) { lastErr = e; }
      }
      if (lastErr) {
        problems.push(o.key + ': ' + (lastErr.message || lastErr.name));
        entries[i] = { key: o.key, size: o.size, error: lastErr.message || lastErr.name };
      }
      finished++; bytes += o.size;
      if (finished % 100 === 0 || finished === objects.length) {
        console.log('  ' + finished + '/' + objects.length + '  ' + human(bytes) + ' of ' + human(total));
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const manifest = {
    bucket: BUCKET,
    takenAt: new Date(t0).toISOString(),
    finishedAt: new Date().toISOString(),
    objects: objects.length,
    totalBytes: total,
    reusedFromEarlierRun: reused,
    verifiedByMd5: entries.filter((e) => e && e.verified === 'md5').length,
    verifiedBySize: entries.filter((e) => e && e.verified === 'size').length,
    problems,
    files: entries,
  };
  if (CHECK) manifest.checkAgainst = Object.assign({ archive: path.resolve(CHECK) }, checkAgainst(CHECK, objects.map((o) => o.key)));
  fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log((problems.length ? 'FINISHED WITH ' + problems.length + ' PROBLEM(S)' : 'DONE') + ' — '
    + objects.length + ' objects, ' + human(total) + ' in ' + OUT);
  console.log('checked by md5: ' + manifest.verifiedByMd5 + ', by size only: ' + manifest.verifiedBySize
    + ', already on disk from an earlier run: ' + reused);
  if (manifest.checkAgainst) {
    const c = manifest.checkAgainst;
    console.log('attachments table: ' + (c.error || (c.present + ' of ' + c.references + ' file references are in this bucket'
      + (c.missing.length ? ' — ' + c.missing.length + ' point at files this bucket does not have (listed in _manifest.json)' : ''))));
  }
  console.log('\nThese are customer photos and documents. Keep the folder on an encrypted drive.');
  if (problems.length) {
    problems.slice(0, 20).forEach((p) => console.error('  ' + p));
    console.error('\nRe-run to retry — files already on disk and verified are kept.');
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\n' + (e.stack || e));
    console.error('\nIf this is an auth error, check the R2_ values came from the project86');
    console.error('service in Railway and that the key can read this bucket.');
    process.exitCode = 1;
  });
}

module.exports = { safeSegment, keyToRel, plainMd5, clashes, checkAgainst };
