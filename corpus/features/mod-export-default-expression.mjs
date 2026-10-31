// mod-export-default-expression -- export default (anonymous expression form)
// group=module module strict
'use strict';
const value = { tag: "v" };
export default value;
T('default', value.tag);
