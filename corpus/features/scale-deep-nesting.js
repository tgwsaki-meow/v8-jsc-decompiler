// scale-deep-nesting -- deeply nested blocks and closures
// group=scale script sloppy
function f() {
  var depth = 0;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  { depth++;
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  }
  var g = function () { return function () { return function () { return function () { return depth; }; }; }; };
  return [depth, g()()()()];
}
T('nesting', f());
