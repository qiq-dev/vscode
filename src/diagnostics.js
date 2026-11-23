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

/** Where on `line` to underline an error whose message quotes something
 * ('y', '+', 'Item'), searching from `column` (counting from 0): the first
 * quoted text found there, as a whole word if it is a name. The compiler
 * positions many errors at the start of the statement they're in, so this
 * points at what the message is about. The leading context, such as
 * `function 'f': `, is skipped. Returns { start, end } or null. */
function quotedOnLine(text, column, message) {
  const literal = literalOnLine(text, column, message);
  if (literal) return literal;
  const body = message.replace(/^(?:(?:function '[^']*'|anonymous function): )+/, "");
  for (const [, quoted] of body.matchAll(/'([^'\n]+)'/g)) {
    const isName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(quoted);
    const escaped = quoted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(isName ? `(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_])` : escaped, "g");
    pattern.lastIndex = column;
    const match = pattern.exec(text);
    if (match) return { start: match.index, end: match.index + quoted.length };
  }
  return null;
}

/** The first string literal ("..." or `...`) on `line`, from `column`,
 * whose text the message contains, as a regular expression error quotes
 * its pattern: `invalid regular expression /(\d+/: ...`. Returns { start,
 * end } around the whole literal, or null. */
function literalOnLine(text, column, message) {
  const literals = /`[^`]*`|"(?:\\.|[^"\\])*"/g;
  literals.lastIndex = column;
  for (let match; (match = literals.exec(text)); ) {
    const inside = match[0].slice(1, -1);
    // Short text such as "a" would be found in almost any message.
    if (inside.length >= 3 && message.includes(inside)) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
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

module.exports = { parseError, quotedOnLine, check };
