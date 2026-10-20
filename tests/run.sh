#!/bin/sh
# Runs the rule tests in the terminal using macOS's built-in JavaScriptCore.
# (On other systems, open tests/index.html in a browser instead.)
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc

"$JSC" "$DIR/js/rules.js" "$DIR/tests/rules.test.js" -e '
const r = globalThis.JamTestResults;
const failed = r.filter((t) => !t.ok);
r.forEach((t) => print((t.ok ? "  pass  " : "  FAIL  ") + t.name + (t.ok ? "" : "\n        " + t.message)));
print("\n" + (r.length - failed.length) + " passed, " + failed.length + " failed");
if (failed.length) quit(1);
'
