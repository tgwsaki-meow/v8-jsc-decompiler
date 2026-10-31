// tools/profilegen/fetch.mjs
//
// Fetch + cache arbitrary files from the upstream V8 repository at a pinned tag,
// over plain HTTPS. No depot_tools, no git, no Python.
//
// Promoted from scratch/recon/fetch_v8.mjs with three production additions:
//   1. cache root is .v8src-cache/<tag>/<path> (gitignored) instead of scratch/
//   2. GitHub raw mirror fallback when gitiles rate-limits or errors
//   3. every successful read records a sha256 provenance entry for meta.json
//
// Politeness: every fetch is cached on disk; 429/503/5xx are retried with
// quadratic backoff; a single in-process inflight map stops duplicate requests.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const GITILES_HOST = 'chromium.googlesource.com';
const GITILES_REPO = '/v8/v8';
const GITHUB_RAW = 'https://raw.githubusercontent.com/v8/v8';

export const DEFAULT_CACHE_ROOT = '.v8src-cache';
const UA = 'V8Disassembler-profilegen/1.0 (+local research tool)';

function httpsGet(url, redirectsLeft = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpsGet(next, redirectsLeft - 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** gitiles raw-blob URL (base64 body). An a.b.c.d version is pinned as refs/tags/<v>. */
export function gitilesUrl(ref, repoPath) {
  const refPart = /^(refs\/|[0-9a-f]{40}$)/.test(ref) ? ref : `refs/tags/${ref}`;
  return `https://${GITILES_HOST}${GITILES_REPO}/+/${refPart}/${repoPath}?format=TEXT`;
}

/** GitHub mirror URL (plain-text body). */
export function githubRawUrl(ref, repoPath) {
  const refPart = ref.replace(/^refs\/tags\//, '');
  return `${GITHUB_RAW}/${refPart}/${repoPath}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * A pinned view of the V8 source tree. Reads are memoised in-process and on disk.
 *
 * `missing` reads are cached too (as a `.missing` marker) so that a 404 for a
 * build artifact such as torque-generated/instance-types.h costs one request
 * per tag, not one per run.
 */
export class V8Source {
  constructor(tag, { cacheRoot = DEFAULT_CACHE_ROOT, offline = false, seedDirs = [] } = {}) {
    this.tag = tag;
    this.cacheRoot = cacheRoot;
    this.offline = offline;
    this.seedDirs = seedDirs;
    this.dir = path.join(cacheRoot, tag.replace(/[\\/:]/g, '_'));
    this.mem = new Map();
    this.inflight = new Map();
    /** repoPath -> {url, sha256, bytes} for every file actually consumed */
    this.provenance = new Map();
  }

  localPath(repoPath) {
    return path.join(this.dir, ...repoPath.split('/'));
  }

  /** Read a file. Returns {text, sha256, url, status, cached} with text === null when absent. */
  async get(repoPath, { optional = false } = {}) {
    if (this.mem.has(repoPath)) return this.mem.get(repoPath);
    if (this.inflight.has(repoPath)) return this.inflight.get(repoPath);
    const p = this._load(repoPath, optional).then((r) => {
      this.mem.set(repoPath, r);
      this.inflight.delete(repoPath);
      if (r.text !== null) {
        this.provenance.set(repoPath, { url: r.url, sha256: r.sha256, bytes: Buffer.byteLength(r.text, 'utf8') });
      }
      return r;
    });
    this.inflight.set(repoPath, p);
    return p;
  }

  /** Like get() but throws when the file is absent. */
  async require(repoPath) {
    const r = await this.get(repoPath);
    if (r.text === null) throw new Error(`${repoPath}@${this.tag} unavailable (HTTP ${r.status})`);
    return r;
  }

  async _load(repoPath, optional) {
    const local = this.localPath(repoPath);
    const marker = local + '.missing';
    if (fs.existsSync(local)) {
      const text = fs.readFileSync(local, 'utf8');
      return { text, sha256: sha256(text), url: gitilesUrl(this.tag, repoPath), status: 200, cached: true };
    }
    if (fs.existsSync(marker)) {
      return { text: null, sha256: null, url: gitilesUrl(this.tag, repoPath), status: Number(fs.readFileSync(marker, 'utf8')) || 404, cached: true };
    }
    // seed from another on-disk cache laid out the same way (saves upstream load)
    for (const seed of this.seedDirs) {
      const cand = path.join(seed, this.tag, ...repoPath.split('/'));
      if (fs.existsSync(cand)) {
        const text = fs.readFileSync(cand, 'utf8');
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, text, 'utf8');
        return { text, sha256: sha256(text), url: gitilesUrl(this.tag, repoPath), status: 200, cached: true };
      }
    }
    if (this.offline) {
      if (optional) return { text: null, sha256: null, url: gitilesUrl(this.tag, repoPath), status: 0, cached: false };
      throw new Error(`offline and not cached: ${repoPath}@${this.tag}`);
    }

    const attempts = [
      { url: gitilesUrl(this.tag, repoPath), decode: (b) => Buffer.from(b.toString('ascii'), 'base64').toString('utf8') },
      { url: githubRawUrl(this.tag, repoPath), decode: (b) => b.toString('utf8') },
    ];
    let last = { status: 0 };
    for (const a of attempts) {
      let res;
      try {
        res = await httpsGet(a.url);
      } catch (e) {
        last = { status: 0, err: String(e) };
        continue;
      }
      for (let i = 0; i < 4 && (res.status === 429 || res.status >= 500); i++) {
        await sleep(1200 * (i + 1) * (i + 1));
        try { res = await httpsGet(a.url); } catch { break; }
      }
      if (res.status === 200) {
        const text = a.decode(res.body);
        fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.writeFileSync(local, text, 'utf8');
        return { text, sha256: sha256(text), url: a.url, status: 200, cached: false };
      }
      last = { status: res.status, url: a.url };
    }
    // genuinely absent (both mirrors agree) -> remember it
    if (last.status === 404) {
      fs.mkdirSync(path.dirname(local), { recursive: true });
      fs.writeFileSync(marker, '404', 'utf8');
    }
    if (!optional) {
      throw new Error(`fetch ${repoPath}@${this.tag} failed: HTTP ${last.status}`);
    }
    return { text: null, sha256: null, url: gitilesUrl(this.tag, repoPath), status: last.status, cached: false };
  }

  /**
   * Bulk-populate the cache for one directory from the gitiles `+archive`
   * endpoint: one HTTPS request instead of one per file. Only paths matching
   * `filter` are written to the cache.
   *
   * Returns the list of repo-relative paths that landed in the cache.
   */
  async primeDirectory(dirPath, filter = () => true) {
    const stamp = path.join(this.dir, '.archive-' + dirPath.replace(/[\\/]/g, '_'));
    if (fs.existsSync(stamp)) return JSON.parse(fs.readFileSync(stamp, 'utf8'));
    if (this.offline) return [];
    const refPart = /^(refs\/|[0-9a-f]{40}$)/.test(this.tag) ? this.tag : `refs/tags/${this.tag}`;
    const url = `https://${GITILES_HOST}${GITILES_REPO}/+archive/${refPart}/${dirPath}.tar.gz`;
    let res;
    try { res = await httpsGet(url); } catch { return []; }
    for (let i = 0; i < 3 && (res.status === 429 || res.status >= 500); i++) {
      await sleep(1500 * (i + 1) * (i + 1));
      try { res = await httpsGet(url); } catch { break; }
    }
    if (res.status !== 200) return [];
    let tar;
    try { tar = zlib.gunzipSync(res.body); } catch { return []; }
    const written = [];
    let off = 0;
    while (off + 512 <= tar.length) {
      const name = tar.toString('utf8', off, off + 100).replace(/\0[\s\S]*$/, '');
      if (!name) break;
      const sizeField = tar.toString('ascii', off + 124, off + 136).replace(/\0[\s\S]*$/, '').trim();
      const size = parseInt(sizeField, 8) || 0;
      const typeflag = String.fromCharCode(tar[off + 156]);
      const body = off + 512;
      if (typeflag === '0' && !name.startsWith('./PaxHeaders')) {
        const repoPath = `${dirPath}/${name.replace(/^\.\//, '')}`;
        if (filter(repoPath)) {
          const local = this.localPath(repoPath);
          fs.mkdirSync(path.dirname(local), { recursive: true });
          fs.writeFileSync(local, tar.subarray(body, body + size));
          written.push(repoPath);
        }
      }
      off = body + Math.ceil(size / 512) * 512;
    }
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, JSON.stringify(written), 'utf8');
    return written;
  }

  /** Sorted provenance list for meta.json. */
  sources() {
    return [...this.provenance.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([repoPath, v]) => ({ path: repoPath, url: v.url, sha256: v.sha256, bytes: v.bytes }));
  }
}

/** Does a tag exist upstream? */
export async function refExists(ref) {
  const refPart = /^(refs\/|[0-9a-f]{40}$)/.test(ref) ? ref : `refs/tags/${ref}`;
  const url = `https://${GITILES_HOST}${GITILES_REPO}/+/${refPart}?format=JSON`;
  const res = await httpsGet(url);
  return { ok: res.status === 200, status: res.status, url };
}
