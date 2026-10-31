// mod-import-named -- import named bindings, with renaming
// group=module module strict
'use strict';
import { named, fn, Klass, mutable, bump, named as alias } from './mod-dep.mjs';
T('importNamed', [named, alias, fn(1), new Klass().m(), mutable]);
T('liveBinding', [bump(), mutable]);
