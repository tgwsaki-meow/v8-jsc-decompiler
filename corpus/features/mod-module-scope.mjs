// mod-module-scope -- module scope: this is undefined, declarations are not on globalThis
// group=module module strict
'use strict';
var moduleVar = 1;
T('this', typeof this); T('notGlobal', typeof globalThis.moduleVar); T('strict', (function () { return this; })() === undefined);
