// regex-flags-combo -- regex flag combinations
// group=regex script sloppy
var rs = [/a/gi, /b/gim, /c/gimsy, /d/gimsuy, /e/dgimsy, /f/v, /g/gv];
T('flags', rs.map(function (r) { return r.flags; }));
T('sources', rs.map(function (r) { return r.source; }));
