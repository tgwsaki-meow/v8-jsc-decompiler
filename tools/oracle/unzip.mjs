// Extract a zip, portably, using whatever the host actually has.
//
// This exists because `tar` is two different programs with the same name:
//
//   Windows 10+   C:\Windows\system32\tar.exe is bsdtar (libarchive), and
//                 bsdtar reads zip.
//   Linux         /usr/bin/tar is GNU tar, which does NOT read zip. It gets as
//                 far as "This does not look like a tar archive" and exits 2.
//
// So spelling it `tar.exe` fails off Windows (ENOENT) and spelling it `tar`
// fails on Linux (wrong format). Both were shipped here in turn, each found by
// CI rather than by review, which is the argument for this file: ask the host
// what it has instead of assuming.
//
// Candidates are tried in order and the first one that exists is used. No
// dependency is added -- every candidate is a program the platform already
// ships or that GitHub's runner images include.

import { execFileSync, spawnSync } from 'node:child_process';

/** Is this program on PATH and runnable? */
function have(cmd) {
  try {
    const probe = cmd === 'unzip' ? ['-v'] : ['--version'];
    const r = spawnSync(cmd, probe, { stdio: 'ignore' });
    return !r.error;
  } catch {
    return false;
  }
}

/**
 * The extractors, in preference order, each as
 * `(zip, dir, members) -> argv`.
 *
 * `members` selects individual entries; both bsdtar and unzip take them as
 * trailing operands, so the same call shape covers "everything" and "just
 * these two files".
 */
const EXTRACTORS = [
  // bsdtar under its own name: present on macOS and on many Linux images, and
  // it is what Windows' tar.exe already is.
  { cmd: 'bsdtar', argv: (zip, dir, members) => ['-xf', zip, '-C', dir, ...members] },
  // Info-ZIP: on every GitHub Linux runner. `-o` overwrite, `-q` quiet.
  { cmd: 'unzip', argv: (zip, dir, members) => ['-o', '-q', zip, ...members, '-d', dir] },
  // Windows' bsdtar. Last because on Linux this name is GNU tar, which cannot
  // read zip -- so it is only reached when nothing better exists, and then it
  // is almost certainly Windows.
  { cmd: process.platform === 'win32' ? 'tar.exe' : 'tar', argv: (zip, dir, members) => ['-xf', zip, '-C', dir, ...members] },
];

/**
 * Extract `zip` into `dir`.
 *
 * @param {string} zip
 * @param {string} dir       must already exist
 * @param {string[]} members specific entries, or [] for the whole archive
 * @returns {string} the program that did it, for the log
 */
export function extractZip(zip, dir, members = []) {
  const tried = [];
  for (const e of EXTRACTORS) {
    if (!have(e.cmd)) { tried.push(`${e.cmd}: not on PATH`); continue; }
    try {
      execFileSync(e.cmd, e.argv(zip, dir, members), { stdio: 'inherit' });
      return e.cmd;
    } catch (err) {
      tried.push(`${e.cmd}: ${String(err.message).split('\n')[0]}`);
    }
  }
  throw new Error(
    `cannot extract ${zip}: no usable zip extractor on this host.\n  ${tried.join('\n  ')}\n`
    + '  install one of bsdtar / unzip, or extract it by hand into ' + dir,
  );
}

export default { extractZip };
