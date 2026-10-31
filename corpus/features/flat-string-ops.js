// flat-string-ops -- string and array builtin calls in top-level code
// group=flat script sloppy
var s = "a,b,,c";
var parts = s.split(",");
var joined = parts.filter(Boolean).join("-");
var idx = s.indexOf("b");
var up = s.toUpperCase().replace(/,/g, ";");
T('strings', [parts.length, joined, idx, up]);
