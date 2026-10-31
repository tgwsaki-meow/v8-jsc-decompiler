// mod-import-mixed -- default + namespace and default + named in one import
// group=module module strict
'use strict';
import dflt, * as ns from './mod-dep.mjs';
import d2, { named } from './mod-dep.mjs';
T('mixed', [dflt === d2, ns.named === named]);
