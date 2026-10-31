// mod-tla -- top-level await
// group=module module strict
'use strict';
const a = await Promise.resolve(1);
const b = await (async function () {
  return a + 1;
})();
for await (const v of [Promise.resolve(b + 1)]) {
  T('tlaForAwait', v);
}
T('tla', [a, b]);
