// class-expression -- class expression, named and anonymous
// group=class script sloppy
var A = class {
  m() {
    return 1;
  }
};
var B = class Named {
  m() {
    return Named.name;
  }
};
T('expr', [A.name, B.name, new A().m(), new B().m()]);
T('iife', new (class { m() { return 'inline'; } })().m());
