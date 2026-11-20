// Tests for src/diagnostics.js. Run with any Node, or with the one inside
// VS Code:
//   ELECTRON_RUN_AS_NODE=1 code test/diagnostics.test.js
"use strict";

const assert = require("assert");
const { parseError, check } = require("../src/diagnostics");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("errors with a position", () => {
  assert.deepStrictEqual(parseError("qiq: main.qiq:1:17: expected ':' before function return type\n", "/p/main.qiq", "/p"), {
    file: "/p/main.qiq",
    line: 1,
    column: 17,
    message: "expected ':' before function return type",
  });
  assert.deepStrictEqual(parseError("qiq: /p/lib/a.qiq:3:2: bad: really\n", "/p/main.qiq", "/p"), {
    file: "/p/lib/a.qiq",
    line: 3,
    column: 2,
    message: "bad: really",
  });
});

test("errors without a position", () => {
  assert.deepStrictEqual(parseError("qiq: main.qiq: variable 'y' is not declared\n", "/p/main.qiq", "/p"), {
    file: "/p/main.qiq",
    line: null,
    column: null,
    message: "variable 'y' is not declared",
  });
  assert.deepStrictEqual(parseError("qiq: import cycle: a -> b\n", "/p/main.qiq", "/p"), {
    file: "/p/main.qiq",
    line: null,
    column: null,
    message: "import cycle: a -> b",
  });
  assert.strictEqual(parseError("", "/p/main.qiq", "/p"), null);
});

test("a missing executable rejects", async () => {
  await assert.rejects(check("/nonexistent/qiq", "/tmp/main.qiq", ""), { code: "ENOENT" });
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${name}\n     ${error.stack.split("\n").slice(0, 8).join("\n     ")}`);
    }
  }
  console.log(`${tests.length - failed} of ${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
