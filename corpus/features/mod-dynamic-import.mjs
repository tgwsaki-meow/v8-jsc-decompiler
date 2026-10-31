// mod-dynamic-import -- dynamic import()
// group=module module strict  (needs a host import hook; reported as unsupported rather than failed when the hook is absent)
'use strict';
import('./mod-dep.mjs').then(function (m) {
  T('dynamicImport', [m.named, typeof m.default]);
}, function (e) {
  T('dynamicImportFailed', e.constructor.name);
});
async function f() {
  const m = await import('./mod-dep.mjs');
  return m.named;
}
f().then(function (v) { T('awaitedImport', v); }, function (e) { T('awaitedImportFailed', e.constructor.name); });
