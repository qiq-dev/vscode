// Compile errors from `qiq check`: running it on a file's text and reading
// the error it reports. Nothing here depends on VS Code, so it can be tested
// on its own (see test/).
"use strict";

const { spawn } = require("child_process");
const path = require("path");

/** Reads the compiler's error output, `qiq: <file>:<line>:<column>: <message>`
 * or `qiq: <file>: <message>`, into `{ file, line, column, message }`. `line`
 * and `column` count from 1, and are null when the error has no position.
 * `file` is absolute (resolved against `cwd`), or `entry` when the error
 * names no file. Returns null for empty output. */
function parseError(output, entry, cwd) {
  const text = output.trim().replace(/^qiq: /, "");
  if (!text) return null;
  const resolve = (file) => path.resolve(cwd, file);
  let match = /^(.+?\.qiq):(\d+):(\d+): ([\s\S]*)$/.exec(text);
  if (match) {
    return { file: resolve(match[1]), line: Number(match[2]), column: Number(match[3]), message: match[4] };
  }
  match = /^(.+?\.qiq): ([\s\S]*)$/.exec(text);
  if (match) return { file: resolve(match[1]), line: null, column: null, message: match[2] };
  return { file: entry, line: null, column: null, message: text };
}

/** Runs `qiq check --stdin <file>` with `text` as the file's contents.
 * Resolves to the error (see parseError), or null when the file compiles.
 * Rejects when qiq can't be run, e.g. ENOENT when it isn't installed. */
function check(qiq, file, text, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const cwd = path.dirname(file);
    const child = spawn(qiq, ["check", "--stdin", file], { cwd, timeout });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) reject(new Error(`qiq check was stopped (${signal})`));
      else resolve(code === 0 ? null : parseError(stderr, file, cwd));
    });
    child.stdin.on("error", () => {}); // the process may exit before reading everything
    child.stdin.end(text);
  });
}

module.exports = { parseError, check };
