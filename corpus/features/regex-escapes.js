// regex-escapes -- regex with slashes, classes and escapes
// group=regex script sloppy
var r = /^[/\\]+(?:a|b)*\d{2,3}$/;
T('source', r.source); T('match', [r.test('//ab12'), r.test('x')]);
var div = 4 / 2 / 1;
T('notRegex', div);
