// mod-reexport -- re-export forms (named, renamed, star, star-as, default)
// group=module module strict
'use strict';
export { named, fn as renamedFn } from './mod-dep.mjs';
export { default } from './mod-dep.mjs';
export * from './mod-dep.mjs';
export * as everything from './mod-dep.mjs';
T('reexport', true);
