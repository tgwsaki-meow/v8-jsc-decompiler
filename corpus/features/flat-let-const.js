// flat-let-const -- top-level let/const (script context slots) vs var (global object)
// group=flat script sloppy  (let/const at script top level live in the script context: LdaCurrentContextSlot, not LdaGlobal)
var v = 1;
let l = 2;
const c = 3;
l = l + v;
T('scriptScope', [v, l, c]);
T('onGlobal', [typeof globalThis.v, typeof globalThis.l]);
