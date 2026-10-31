// mod-export-named -- export declarations in every named form
// group=module module strict
'use strict';
export var v = 1;
export let l = 2;
export const c = 3;
export function f() {
  return 4;
}
export class C {}
export async function af() {
  return 5;
}
export function* gf() {
  yield 6;
}
const a = 7, b = 8;
export { a, b as renamed };
T('named', [v, l, c, f(), new C() instanceof C, [...gf()], a, b]);
