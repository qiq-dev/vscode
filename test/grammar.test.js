// Tokenizes qiq with the TextMate engine VS Code uses, and checks the scopes
// that highlighting is based on. Needs vscode-textmate and vscode-oniguruma:
// installed with npm, or (by default) the copies inside VS Code itself:
//   ELECTRON_RUN_AS_NODE=1 code test/grammar.test.js
// Set QIQ_VSCODE_APP to VS Code's resources/app directory if it's elsewhere.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

function load(name) {
  try {
    return { module: require(name), directory: path.dirname(require.resolve(name)) };
  } catch (error) {
    const apps = [process.env.QIQ_VSCODE_APP, "/snap/code/current/usr/share/code/resources/app", "/usr/share/code/resources/app", "/opt/visual-studio-code/resources/app", "/Applications/Visual Studio Code.app/Contents/Resources/app"].filter(Boolean);
    for (const app of apps) {
      try {
        return { module: require(path.join(app, "node_modules.asar", name)), directory: path.join(app, "node_modules.asar.unpacked", name) };
      } catch (ignored) {}
    }
    return null;
  }
}

const textmate = load("vscode-textmate");
const oniguruma = load("vscode-oniguruma");
if (!textmate || !oniguruma) {
  console.log("skipped: vscode-textmate and vscode-oniguruma not found (set QIQ_VSCODE_APP)");
  process.exit(0);
}

async function grammarFor(file, scopeName) {
  const wasm = fs.readFileSync(path.join(oniguruma.directory, "release", "onig.wasm"));
  await oniguruma.module.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength));
  const registry = new textmate.module.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new oniguruma.module.OnigScanner(patterns),
      createOnigString: (text) => new oniguruma.module.OnigString(text),
    }),
    loadGrammar: async (scope) => (scope === scopeName ? textmate.module.parseRawGrammar(fs.readFileSync(file, "utf8"), file) : null),
  });
  return registry.loadGrammar(scopeName);
}

/** Tokenizes `source` and returns a function from a piece of text (the
 * n-th occurrence) to the innermost scope of its first token. */
function scopes(grammar, source) {
  const tokens = [];
  let state = textmate.module.INITIAL;
  source.split("\n").forEach((line, lineNumber) => {
    const result = grammar.tokenizeLine(line, state);
    for (const token of result.tokens) tokens.push({ line: lineNumber, text: line.slice(token.startIndex, token.endIndex), start: token.startIndex, scopes: token.scopes });
    state = result.ruleStack;
  });
  const lines = source.split("\n");
  return (text, occurrence = 1) => {
    let seen = 0;
    for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
      // Words match whole words only: "as" isn't the "as" in "class".
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(/^\w/.test(text) ? `(?<!\\w)${escaped}${/\w$/.test(text) ? "(?!\\w)" : ""}` : escaped, "g");
      let match;
      while ((match = pattern.exec(lines[lineNumber]))) {
        const index = match.index;
        if (++seen === occurrence) {
          const token = tokens.find((t) => t.line === lineNumber && t.start <= index && index < t.start + Math.max(1, t.text.length));
          return token.scopes[token.scopes.length - 1];
        }
      }
    }
    throw new Error(`'${text}' (#${occurrence}) isn't in the source`);
  };
}

const SOURCE = `// A comment with "quotes" and class
import Router as Mux, http_serve from "std/net/http/server";

abstract class Shape extends Base implements Drawable, Named {
    private static int count = 0;
    public string name;
    abstract function area(): double;
}

function greet(string name, int times = 2): string {
    char c = '\\n';
    string s = "tab\\there \\q";
    double d = 3.14;
    map[string, int] ages = {"ada" => 36};
    foreach (range(1, times) as i) {
        print(sprintf("%s", name));
    }
    Shape shape = new Circle(1.5);
    shape->area();
    x = shape->name ?? null;
    Shape::create(this);
    parent::__construct();
    f = fn(int x) => x * 2;
    function(int): int g = function(int y): int { return y; };
    http_get(url, timeout: 5);
    return true && !false;
}

class Point {
    const ORIGIN = 0;
    function __construct(public readonly int x) {}
}
if (shape instanceof Circle circle) {
    print(shape::class, Point::class, holder?->point?->norm());
    count++;
    total += 2;
    mask <<= 1;
}
/* A block comment with class
   and "quotes" */ int after = 1;
/** Documented. */
int y = 2 /* inline */ + 3;
`;

(async () => {
  const qiq = await grammarFor(path.join(__dirname, "..", "syntaxes", "qiq.tmLanguage.json"), "source.qiq");
  const scope = scopes(qiq, SOURCE);
  const expected = [
    ["const", 1, "storage.type.const.qiq"],
    ["readonly", 1, "storage.modifier.qiq"],
    ["instanceof", 1, "keyword.operator.instanceof.qiq"],
    ["shape::class", 1, "variable.other.qiq"],
    ["::class", 1, "punctuation.separator.static.qiq"],
    ["Point::class", 1, "entity.name.type.class.qiq"],
    ["?->", 1, "punctuation.accessor.arrow.qiq"],
    ["norm", 1, "entity.name.function.member.qiq"],
    ["++", 1, "keyword.operator.increment.qiq"],
    ["+=", 1, "keyword.operator.assignment.compound.qiq"],
    ["<<=", 1, "keyword.operator.assignment.compound.qiq"],
    ["/* A block", 1, "comment.block.qiq"],
    ["and \"quotes\"", 1, "comment.block.qiq"],
    ["int after", 1, "storage.type.primitive.qiq"],
    ["/** Documented", 1, "comment.block.documentation.qiq"],
    ["/* inline", 1, "comment.block.qiq"],
    ["+ 3", 1, "keyword.operator.arithmetic.qiq"],
    ["// A comment", 1, "comment.line.double-slash.qiq"],
    ["class", 1, "comment.line.double-slash.qiq"],
    ["import", 1, "keyword.control.import.qiq"],
    ["Router", 1, "entity.name.type.qiq"],
    ["as", 1, "keyword.control.import.qiq"],
    ["http_serve", 1, "entity.name.function.qiq"],
    ["from", 1, "keyword.control.import.qiq"],
    ["std/net/http/server", 1, "string.quoted.double.qiq"],
    ["abstract", 1, "storage.modifier.qiq"],
    ["class", 2, "storage.type.class.qiq"],
    ["Shape", 1, "entity.name.type.class.qiq"],
    ["extends", 1, "storage.modifier.extends.qiq"],
    ["Base", 1, "entity.other.inherited-class.qiq"],
    ["Drawable", 1, "entity.other.inherited-class.qiq"],
    ["private", 1, "storage.modifier.qiq"],
    ["int", 1, "storage.type.primitive.qiq"],
    ["0", 1, "constant.numeric.integer.qiq"],
    ["area", 1, "entity.name.function.qiq"],
    ["greet", 1, "entity.name.function.qiq"],
    ["'\\n'", 1, "string.quoted.single.qiq"],
    ["\\t", 1, "constant.character.escape.qiq"],
    ["\\q", 1, "invalid.illegal.escape.qiq"],
    ["3.14", 1, "constant.numeric.float.qiq"],
    ["map", 1, "storage.type.primitive.qiq"],
    ["=>", 1, "keyword.operator.arrow.qiq"],
    ["foreach", 1, "keyword.control.qiq"],
    ["range", 1, "entity.name.function.call.qiq"],
    ["as", 2, "keyword.control.qiq"],
    ["print", 1, "support.function.builtin.qiq"],
    ["new", 1, "keyword.other.new.qiq"],
    ["Circle", 1, "entity.name.type.class.qiq"],
    ["->", 1, "punctuation.accessor.arrow.qiq"],
    ["area", 2, "entity.name.function.member.qiq"],
    ["name", 4, "variable.other.property.qiq"],
    ["??", 1, "keyword.operator.null-coalescing.qiq"],
    ["null", 1, "constant.language.qiq"],
    ["Shape::", 1, "entity.name.type.class.qiq"],
    ["create", 1, "entity.name.function.member.qiq"],
    ["this", 1, "variable.language.this.qiq"],
    ["parent", 1, "variable.language.qiq"],
    ["fn", 1, "storage.type.function.arrow.qiq"],
    ["function(int)", 1, "storage.type.function.qiq"],
    ["timeout", 1, "variable.parameter.named.qiq"],
    ["return", 1, "keyword.control.qiq"],
    ["true", 1, "constant.language.qiq"],
    ["&&", 1, "keyword.operator.logical.qiq"],
  ];
  let failed = 0;
  for (const [text, occurrence, want] of expected) {
    const got = scope(text, occurrence);
    if (got !== want) {
      failed++;
      console.log(`FAIL '${text}' #${occurrence}: ${got}, expected ${want}`);
    }
  }

  const mod = await grammarFor(path.join(__dirname, "..", "syntaxes", "qiq-mod.tmLanguage.json"), "source.qiq-mod");
  const modScope = scopes(mod, "module example.com/app\n\nqiq 0.1\n\nrequire (\n    github.com/ada/web v1.4.2\n    github.com/lin/slug v0.3.0 // indirect\n)\nreplace github.com/ada/web => ../web\ngithub.com/ada/web v1.4.2 h1:P3wFdtmx=");
  for (const [text, occurrence, want] of [
    ["module", 1, "keyword.other.directive.qiq-mod"],
    ["example.com/app", 1, "entity.name.module.qiq-mod"],
    ["0.1", 1, "constant.numeric.version.qiq-mod"],
    ["v1.4.2", 1, "constant.numeric.version.qiq-mod"],
    ["// indirect", 1, "comment.line.double-slash.indirect.qiq-mod"],
    ["=>", 1, "keyword.operator.arrow.qiq-mod"],
    ["../web", 1, "string.unquoted.path.qiq-mod"],
    ["h1:", 1, "constant.other.hash.qiq-mod"],
  ]) {
    const got = modScope(text, occurrence);
    if (got !== want) {
      failed++;
      console.log(`FAIL qiq.mod '${text}' #${occurrence}: ${got}, expected ${want}`);
    }
  }
  const total = expected.length + 8;
  console.log(`${total - failed} of ${total} scopes as expected`);
  process.exitCode = failed ? 1 : 0;
})();
