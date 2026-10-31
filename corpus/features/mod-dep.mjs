// mod-dep -- module that exists to be imported (named + default exports)
// group=module module strict  (the dependency for the mod-import-* entries)
'use strict';
export const named = 1;
export let mutable = 2;
export function fn(a) {
  return a + 1;
}
export class Klass {
  m() {
    return "k";
  }
}
export default function dflt() {
  return "default";
}
export function bump() {
  mutable += 1;
  return mutable;
}
if (typeof T === 'function') T('depEvaluated', named);
