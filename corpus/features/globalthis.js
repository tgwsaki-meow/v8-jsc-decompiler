// globalthis -- globalThis and global object access
// group=numeric script sloppy
function f() {
  globalThis.__corpusMarker = 1;
  return [typeof globalThis, globalThis.__corpusMarker, "__corpusMarker" in globalThis];
}
T('globalThis', f()); T('selfRef', globalThis === globalThis.globalThis);
