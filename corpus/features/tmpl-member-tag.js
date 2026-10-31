// tmpl-member-tag -- tagged template with a member-expression tag
// group=template script sloppy
var o = {
  tag: function (s, v) {
    return [this === o, s[0], v];
  },
};
T('memberTag', o.tag`q${7}`);
