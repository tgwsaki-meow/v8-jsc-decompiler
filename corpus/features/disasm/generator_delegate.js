function* inner() { yield 1; yield 2; }
function* outer() { yield* inner(); yield 3; }
var it = outer(); it.next(); it.next(); it.next();
