async function f(p) {
  try { var a = await p; return a + 1; }
  catch (e) { return -1; }
  finally { globalThis.__x = 1; }
}
f(Promise.resolve(1));
