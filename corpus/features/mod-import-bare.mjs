// mod-import-bare -- side-effect-only import
// group=module module strict
'use strict';
import './mod-dep.mjs';
T('bareImport', true);
