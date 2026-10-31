// mod-export-default-function -- export default (function declaration form)
// group=module module strict
'use strict';
export default function theDefault() {
  return "d";
}
T('default', theDefault());
