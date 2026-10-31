// mod-import-default -- import default binding
// group=module module strict
'use strict';
import dflt from './mod-dep.mjs';
T('importDefault', dflt());
