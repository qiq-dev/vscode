// Runs every test file in this directory:
//   ELECTRON_RUN_AS_NODE=1 code test/run.js     (or: node test/run.js)
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

let failed = false;
for (const file of ["analysis.test.js", "diagnostics.test.js", "extension.test.js", "grammar.test.js"]) {
  console.log(`== ${file}`);
  const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: "inherit", env: process.env });
  if (result.status !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
