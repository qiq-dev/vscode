// Tests src/extension.js's providers against a stand-in for the `vscode`
// module, so they run without VS Code:
//   ELECTRON_RUN_AS_NODE=1 code test/extension.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

// ---------------------------------------------------------------------------
// A minimal `vscode`

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  compareTo(other) {
    return this.line - other.line || this.character - other.character;
  }
}
class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}
const providers = {};
const handlers = {};
const settings = {};
/** What the extension set on its diagnostic collection: URI -> diagnostics. */
const problems = new Map();
const vscode = {
  Position,
  Range,
  CompletionItem: class {
    constructor(label, kind) {
      this.label = label;
      this.kind = kind;
    }
  },
  CompletionItemKind: { Function: 3, Method: 2, Field: 5, Variable: 6, Class: 7, Interface: 8, Module: 9, Keyword: 14, File: 17, Folder: 19, Constant: 21, TypeParameter: 25 },
  SymbolKind: { Function: 12, Class: 5, Interface: 11, Field: 8, Method: 6, Constructor: 9 },
  SnippetString: class {
    constructor(value) {
      this.value = value;
    }
  },
  MarkdownString: class {
    constructor(value = "") {
      this.value = value;
    }
    appendCodeblock(code) {
      this.value += "```\n" + code + "\n```\n";
      return this;
    }
    appendMarkdown(text) {
      this.value += text;
      return this;
    }
  },
  TextEdit: { insert: (position, newText) => ({ range: new Range(position, position), newText }) },
  Hover: class {
    constructor(contents, range) {
      this.contents = contents;
      this.range = range;
    }
  },
  SignatureHelp: class {},
  SignatureInformation: class {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
      this.parameters = [];
    }
  },
  ParameterInformation: class {
    constructor(label, documentation) {
      this.label = label;
      this.documentation = documentation;
    }
  },
  DocumentSymbol: class {
    constructor(name, detail, kind, range, selectionRange) {
      Object.assign(this, { name, detail, kind, range, selectionRange, children: [] });
    }
  },
  Location: class {
    constructor(uri, position) {
      this.uri = uri;
      this.range = new Range(position, position);
    }
  },
  Uri: { file: (fsPath) => ({ fsPath, toString: () => "file://" + fsPath }) },
  languages: {
    registerCompletionItemProvider: (selector, provider) => (providers.completion = provider),
    registerHoverProvider: (selector, provider) => (providers.hover = provider),
    registerSignatureHelpProvider: (selector, provider) => (providers.signature = provider),
    registerDefinitionProvider: (selector, provider) => (providers.definition = provider),
    registerDocumentSymbolProvider: (selector, provider) => (providers.symbols = provider),
    createDiagnosticCollection: () => ({
      set: (uri, diagnostics) => problems.set(uri.toString(), diagnostics),
      delete: (uri) => problems.delete(uri.toString()),
      dispose: () => problems.clear(),
    }),
  },
  Diagnostic: class {
    constructor(range, message, severity) {
      Object.assign(this, { range, message, severity });
    }
  },
  DiagnosticSeverity: { Error: 0 },
  window: { showWarningMessage: (message) => (handlers.warning = message) },
  workspace: {
    textDocuments: [],
    getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
    onDidSaveTextDocument: () => ({}),
    onDidCloseTextDocument: () => ({}),
    onDidOpenTextDocument: () => ({}),
    onDidChangeTextDocument: (handler) => (handlers.change = handler),
    onDidChangeConfiguration: () => ({}),
  },
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === "vscode" ? vscode : load.call(this, request, ...rest);
};

let version = 0;
/** A TextDocument for `text` at `file`. */
function documentOf(file, text) {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const document = {
    uri: { ...vscode.Uri.file(file), scheme: "file" },
    languageId: "qiq",
    isClosed: false,
    version: ++version,
    lineCount: lineStarts.length,
    getText(range) {
      return range ? text.slice(this.offsetAt(range.start), this.offsetAt(range.end)) : text;
    },
    offsetAt(position) {
      return lineStarts[position.line] + position.character;
    },
    positionAt(offset) {
      let line = 0;
      while (line + 1 < lineStarts.length && lineStarts[line + 1] <= offset) line++;
      return new Position(line, offset - lineStarts[line]);
    },
    lineAt(line) {
      const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
      return { text: text.slice(lineStarts[line], end), range: new Range(new Position(line, 0), new Position(line, end - lineStarts[line])) };
    },
    getWordRangeAtPosition(position, pattern) {
      const offset = this.offsetAt(position);
      let start = offset;
      let end = offset;
      while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
      return start === end ? undefined : new Range(this.positionAt(start), this.positionAt(end));
    },
  };
  return document;
}

/** A document from source with | at the cursor, and the cursor's position. */
function at(file, source) {
  const offset = source.indexOf("|");
  const text = source.slice(0, offset) + source.slice(offset + 1);
  const document = documentOf(file, text);
  return { document, position: document.positionAt(offset), text };
}

const extension = require("../src/extension");
extension.activate({ subscriptions: [] });

const labels = (items) => (items || []).map((item) => (typeof item.label === "string" ? item.label : item.label.label));
async function complete(file, source, triggerCharacter) {
  const { document, position } = at(file, source);
  return providers.completion.provideCompletionItems(document, position, null, { triggerCharacter });
}
function applyEdits(text, document, edits) {
  let result = text;
  for (const edit of [...edits].sort((a, b) => document.offsetAt(b.range.start) - document.offsetAt(a.range.start))) {
    const offset = document.offsetAt(edit.range.start);
    result = result.slice(0, offset) + edit.newText + result.slice(offset);
  }
  return result;
}

// ---------------------------------------------------------------------------

const root = fs.mkdtempSync(path.join(os.tmpdir(), "qiq-extension-"));
const write = (file, text) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
  return path.join(root, file);
};
write("qiq.mod", "module example.com/shop\n");
write("models/item.qiq", "// Something to buy.\nclass Item {\n    public string name;\n    public double price;\n    private int stock;\n    function __construct(string name, double price) {\n        this->name = name;\n        this->price = price;\n    }\n    function label(): string { return this->name; }\n}\nprivate function helper(): int { return 1; }\nfunction format_price(double price): string { return \"\"; }\n");
const MAIN = path.join(root, "main.qiq");

const BASKET = `import Item from "models/item";

class Basket {
    private Item[] items;
    protected int count;
    public string owner;

    function add(Item item, int quantity = 1): Basket {
        return this;
    }
}

class GiftBasket extends Basket {
    function wrap(): void {
        CURSOR
    }
}
`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("members after -> by declared type, with visibility", async () => {
  const outside = await complete(MAIN, BASKET + "Basket b = new Basket();\nb->|", ">");
  assert.deepStrictEqual(labels(outside).sort(), ["add", "owner"]);
  const inside = await complete(MAIN, BASKET.replace("return this;", "this->|"), ">");
  assert.deepStrictEqual(labels(inside).sort(), ["add", "count", "items", "owner"]);
  const subclass = await complete(MAIN, BASKET.replace("CURSOR", "this->|"), ">");
  assert.deepStrictEqual(labels(subclass).sort(), ["add", "count", "owner", "wrap"], "a subclass sees protected, not private");
  const chained = await complete(MAIN, BASKET + "Basket b = new Basket();\nb->add(new Item(\"a\", 1.0))->|", ">");
  assert.deepStrictEqual(labels(chained).sort(), ["add", "owner"]);
  const imported = await complete(MAIN, BASKET + "Item i = new Item(\"a\", 1.0);\ni->|", ">");
  assert.deepStrictEqual(labels(imported).sort(), ["label", "name", "price"]);
  const loop = await complete(MAIN, BASKET + "Item[] all = [];\nforeach (all as item) {\n    item->|\n}", ">");
  assert.ok(labels(loop).includes("label"), "foreach variables get the element type");
  assert.strictEqual(await complete(MAIN, "x = 1 >|", ">"), undefined, "a lone > isn't member access");
});

test("standard library members and statics", async () => {
  const file = await complete(MAIN, 'import File from "std/file";\nFile f = File::open("x");\nf->|', ">");
  assert.ok(labels(file).includes("readLine") && labels(file).includes("close"));
  assert.ok(!labels(file).includes("open"), "static methods aren't offered after ->");
  const statics = await complete(MAIN, 'import File from "std/file";\nFile::|', ":");
  assert.deepStrictEqual(labels(statics).sort(), ["class", "open", "stderr", "stdin", "stdout"]);
  const exception = await complete(MAIN, "try { } catch (RuntimeException e) {\n    e->|\n}", ">");
  assert.deepStrictEqual(labels(exception).sort(), ["getCode", "getFile", "getLine", "getMessage"], "inherited from Exception");
});

test("untyped callback parameters take their types from where they're passed", async () => {
  // A standard library function, imported.
  const regex = await complete(MAIN, 'import preg_replace_callback from "std/regex";\nstring s = preg_replace_callback(`/x/`, fn(m) => m->|, "x");', ">");
  assert.ok(labels(regex).includes("group") && labels(regex).includes("text"), labels(regex).join());
  // A method's callback with two parameters.
  const router = await complete(MAIN, 'import Router from "std/net/http/server";\nRouter r = new Router();\nr->handle("GET /", fn(request, w) => w->|);', ">");
  assert.ok(labels(router).includes("write") && labels(router).includes("status"), labels(router).join());
  // A function of this file, by name, and a declared function-typed variable.
  const own = await complete(MAIN, "class Item { public string name; }\nfunction each(Item[] items, function(int, Item): void visit): void {}\neach(visit: fn(index, item) => item->|, items: []);", ">");
  assert.deepStrictEqual(labels(own), ["name"]);
  const declared = await complete(MAIN, "class Item { public string name; }\nfunction(Item): string f = fn(it) => it->|;", ">");
  assert.deepStrictEqual(labels(declared), ["name"]);
  // Built-ins with placeholder types: T from the array, K and V from the map, U from the initial value.
  const filtered = await complete(MAIN, "class Item { public string name; }\nItem[] items = [];\nItem[] some = array_filter(items, fn(it) => it->|);", ">");
  assert.deepStrictEqual(labels(filtered), ["name"]);
  const reduced = await complete(MAIN, "class Item { public string name; }\nclass Total { public int sum; }\nItem[] items = [];\nTotal t = array_reduce(items, fn(total, it) => total->|, new Total());", ">");
  assert.deepStrictEqual(labels(reduced), ["sum"]);
  const mapped = await complete(MAIN, "class Item { public string name; }\nmap[string, Item] byName = {};\nprint(map_filter(byName, fn(key, it) => it->|));", ">");
  assert.deepStrictEqual(labels(mapped), ["name"]);
  const sorted = await complete(MAIN, "class Item { public string name; }\nItem[] items = [];\nItem[] s = usort(items, fn(a, b) => strcmp(a->name, b->|));", ">");
  assert.deepStrictEqual(labels(sorted), ["name"]);
});

test("newer syntax: ?->, ::class, instanceof, promotion, readonly, constants, and query values", async () => {
  const classes =
    "class Point {\n    const ORIGIN = 0;\n    const string LABEL = \"pt\";\n    function __construct(public readonly int x, private int y = 0, int plain = 1) {}\n    function norm(): int { return 0; }\n}\n" +
    "class Holder {\n    public Point point;\n}\n";
  // Promoted parameters are properties; a plain parameter isn't.
  const members = await complete(MAIN, classes + "Point p = new Point(1);\np->|", ">");
  assert.ok(labels(members).includes("x") && labels(members).includes("norm"), labels(members).join());
  assert.ok(!labels(members).includes("y"), "a private promoted property isn't offered outside");
  assert.ok(!labels(members).includes("plain"));
  // After ?->, and through a ?-> chain.
  const nullsafe = await complete(MAIN, classes + "Holder h = null;\nh?->point?->|", ">");
  assert.ok(labels(nullsafe).includes("x"), labels(nullsafe).join());
  // Constants and class after Class::, and class after value::.
  const statics = await complete(MAIN, classes + "Point::|", ":");
  assert.ok(["ORIGIN", "LABEL", "class"].every((name) => labels(statics).includes(name)), labels(statics).join());
  const value = await complete(MAIN, classes + "Point p = new Point(1);\np::|", ":");
  assert.deepStrictEqual(labels(value), ["class"]);
  // instanceof binds a typed variable.
  const bound = await complete(MAIN, classes + "Point q = null;\nif (q instanceof Point point) {\n    point->|\n}", ">");
  assert.ok(labels(bound).includes("norm"), labels(bound).join());
  // A string from ::class.
  const name = await complete(MAIN, classes + "s = Point::class;\n|", "");
  const variable = name.find((item) => (item.label.label || item.label) === "s");
  assert.strictEqual(variable && variable.label.description, "string");
  // The values after a query's SQL, and queryAs.
  const { document, position } = at(MAIN, 'import Database from "std/sql";\nDatabase db = Database::open("sqlite::memory:");\ndb->query("select ?", 1, |');
  const help = await providers.signature.provideSignatureHelp(document, position);
  assert.strictEqual(help.signatures[0].label, "Database::query(string sql, ...values): Row[]");
  assert.strictEqual(help.activeParameter, 1);
  const database = await complete(MAIN, 'import Database from "std/sql";\nDatabase db = Database::open("x");\ndb->|', ">");
  assert.ok(["queryAs", "queryOneAs", "cursor", "transaction"].every((method) => labels(database).includes(method)), labels(database).join());
  // Hovers show readonly and const.
  const hoverAt = async (source) => {
    const { document, position } = at(MAIN, source);
    const result = await providers.hover.provideHover(document, position);
    return result ? result.contents.value : "";
  };
  assert.ok((await hoverAt(classes + "Point p = new Point(1);\nint a = p->|x;")).includes("readonly int Point::x"));
  assert.ok((await hoverAt(classes + "int b = Point::OR|IGIN;")).includes("const int Point::ORIGIN = 0"));
});

test("completion with auto-import", async () => {
  const source = 'import File from "std/file";\n\nstring s = file_get|';
  const { document, position, text } = at(MAIN, source);
  const items = await providers.completion.provideCompletionItems(document, position, null, {});
  const item = items.find((i) => i.label.label === "file_get_contents");
  assert.ok(item, "std functions are offered before they're imported");
  assert.strictEqual(item.label.description, "std/file");
  assert.strictEqual(applyEdits(text, document, item.additionalTextEdits).split("\n")[0], 'import File, file_get_contents from "std/file";');
  const date = items.find((i) => i.label.label === "date");
  assert.strictEqual(applyEdits(text, document, date.additionalTextEdits).split("\n").slice(0, 2).join("\n"), 'import File from "std/file";\nimport date from "std/time";');
  const fresh = at(MAIN, "// My program.\nprint(1);\nRou|");
  const freshItems = await providers.completion.provideCompletionItems(fresh.document, fresh.position, null, {});
  const router = freshItems.find((i) => i.label.label === "Router");
  assert.strictEqual(
    applyEdits(fresh.text, fresh.document, router.additionalTextEdits),
    '// My program.\nimport Router from "std/net/http/server";\n\nprint(1);\nRou'
  );
  assert.ok(!freshItems.some((i) => i.label.label === "trim" && i.additionalTextEdits), "prelude functions need no import");
  const imported = await complete(MAIN, 'import File from "std/file";\nFil|');
  assert.ok(!imported.some((i) => i.label.label === "File" && i.additionalTextEdits), "imported names aren't imported again");
});

test("general completion: variables, own declarations, keywords", async () => {
  const items = await complete(MAIN, "function total(int a): int {\n    int sum = 0;\n    return |;\n}\nstring topLevel = \"\";");
  const names = labels(items);
  for (const expected of ["a", "sum", "total", "len", "foreach", "int"]) assert.ok(names.includes(expected), expected);
  assert.ok(!names.includes("topLevel"), "top-level variables aren't visible in functions");
  assert.strictEqual(await complete(MAIN, "// comment |"), undefined);
  assert.strictEqual(await complete(MAIN, 'print("text |");'), undefined);
});

test("new, types, and import paths and names", async () => {
  const created = await complete(MAIN, 'import Item from "models/item";\nx = new |');
  const names = labels(created);
  assert.ok(names.includes("Item") && names.includes("Router") && names.includes("RuntimeException"));
  assert.strictEqual(created.find((i) => i.label.label === "Item").insertText.value, "Item($0)");
  const paths = await complete(MAIN, 'import X from "std/|";', "/");
  assert.ok(labels(paths).includes("std/net/http/server"));
  const relative = await complete(MAIN, 'import X from "mod|";', '"');
  assert.ok(labels(relative).includes("models/"), labels(relative).join(","));
  const inside = await complete(MAIN, 'import X from "models/|";', "/");
  assert.ok(labels(inside).includes("models/item"));
  const module = await complete(MAIN, 'import X from "example.com/shop/models/|";', "/");
  assert.ok(labels(module).includes("example.com/shop/models/item"), labels(module).join(","));
  const exported = await complete(MAIN, 'import | from "models/item";');
  assert.deepStrictEqual(labels(exported).sort(), ["Item", "format_price", "helper"], "private names import within the module");
  const std = await complete(MAIN, 'import | from "std/time";');
  assert.ok(labels(std).includes("date") && labels(std).includes("strtotime"));
  const caught = await complete(MAIN, "try { } catch (|");
  assert.ok(labels(caught).includes("NetworkException"));
});

test("hovers", async () => {
  const hover = async (source) => {
    const { document, position } = at(MAIN, source);
    const result = await providers.hover.provideHover(document, position);
    return result && result.contents.value;
  };
  assert.ok((await hover("int n = le|n(\"ab\");")).includes("len(string|array|map value)") || (await hover("int n = le|n(\"ab\");")).includes("len("));
  const fileGet = await hover('import file_get_contents from "std/file";\nstring s = file_get_con|tents("a");');
  assert.ok(fileGet.includes("function file_get_contents(string path): string") && fileGet.includes('import file_get_contents from "std/file"'), fileGet);
  const method = await hover(BASKET + "Basket b = new Basket();\nb->a|dd(null);");
  assert.ok(method.includes("function Basket::add(Item item, int quantity = 1): Basket"), method);
  const cls = await hover('import Item from "models/item";\nIt|em i = null;');
  assert.ok(cls.includes("class Item") && cls.includes("Something to buy."), cls);
  const variable = await hover("int count = 1;\nprint(cou|nt);");
  assert.ok(variable.includes("int count"));
});

test("parameter hints", async () => {
  const hint = async (source) => {
    const { document, position } = at(MAIN, source);
    return providers.signature.provideSignatureHelp(document, position);
  };
  const put = await hint('import file_put_contents from "std/file";\nfile_put_contents("a", |');
  assert.strictEqual(put.signatures[0].label, "file_put_contents(string path, string data, bool append = false): int");
  assert.strictEqual(put.activeParameter, 1);
  const named = await hint('import http_get from "std/net/http";\nhttp_get("u", timeout: |');
  assert.strictEqual(named.activeParameter, 2);
  const constructor = await hint('import Item from "models/item";\nx = new Item("a", |');
  assert.strictEqual(constructor.signatures[0].label, "Item(string name, double price)");
  assert.strictEqual(constructor.activeParameter, 1);
  const method = await hint(BASKET + "Basket b = new Basket();\nb->add(null, |");
  assert.strictEqual(method.signatures[0].label, "Basket::add(Item item, int quantity = 1): Basket");
  const value = await hint("function(int, string): bool f = null;\nf(1, |");
  assert.strictEqual(value.signatures[0].label, "f(int arg1, string arg2): bool");
  assert.strictEqual(await hint("if (|"), null);
});

test("go to definition and the outline", async () => {
  const { document, position } = at(MAIN, 'import Item from "models/item";\nIt|em i = null;');
  const location = await providers.definition.provideDefinition(document, position);
  assert.strictEqual(location.uri.fsPath, path.join(root, "models/item.qiq"));
  assert.strictEqual(location.range.start.line, 1);
  const own = at(MAIN, BASKET + "Basket b = new Basket();\nb->a|dd(null);");
  const method = await providers.definition.provideDefinition(own.document, own.position);
  assert.strictEqual(method.range.start.line, 7);
  const symbols = providers.symbols.provideDocumentSymbols(documentOf(MAIN, BASKET + "function helper(): void {}\n"));
  assert.deepStrictEqual(symbols.map((s) => s.name), ["Basket", "GiftBasket", "helper"]);
  assert.deepStrictEqual(symbols[0].children.map((c) => c.name), ["items", "count", "owner", "add"]);
});

// The real compiler: $QIQ, or one built in a qiq repository next to this
// one (../qiq); otherwise the test is skipped.
const QIQ = [
  process.env.QIQ,
  ...["release", "debug"].map((build) => path.join(__dirname, "../../qiq/target", build, "qiq")),
].find((file) => file && fs.existsSync(file));

test("compile errors as you type", async () => {
  if (!QIQ) return console.log("     (skipped: build qiq first)");
  settings.path = QIQ;
  /** Edits `file` to `text` and waits for the check to finish. */
  async function edit(file, text) {
    const document = documentOf(file, text);
    const key = document.uri.toString();
    const before = problems.get(key);
    handlers.change({ document });
    for (let waited = 0; waited < 5000 && problems.get(key) === before; waited += 20) await new Promise((r) => setTimeout(r, 20));
    await new Promise((r) => setTimeout(r, 400));
    return problems.get(key) || [];
  }
  const file = write("check/main.qiq", "");
  write("check/lib.qiq", "function half(int n): int {\n  return n / 2\n}\n");

  const [syntax] = await edit(file, "function main() {\n}\n");
  assert.match(syntax.message, /expected ':' before function return type/);
  assert.deepStrictEqual([syntax.range.start.line, syntax.range.start.character], [0, 16]);

  assert.deepStrictEqual(await edit(file, 'print("hi");\n'), []);

  // Type errors are positioned at their statement; what the message quotes
  // is underlined.
  const [undeclared] = await edit(file, 'print("hi");\nprint(y);\n');
  assert.strictEqual(undeclared.message, "variable 'y' is not declared");
  assert.deepStrictEqual([undeclared.range.start.line, undeclared.range.start.character, undeclared.range.end.character], [1, 6, 7]);
  const [inFunction] = await edit(file, "function f(int n): int {\n  int x = \"a\";\n  return x;\n}\nprint(f(1));\n");
  assert.strictEqual(inFunction.message, "function 'f': cannot initialize int variable 'x' with string");
  assert.deepStrictEqual([inFunction.range.start.line, inFunction.range.start.character], [1, 6]);
  const [missingReturn] = await edit(file, "function f(int n): int {\n  print(n);\n}\n");
  assert.match(missingReturn.message, /must return a value on every path/);
  assert.deepStrictEqual([missingReturn.range.start.line, missingReturn.range.start.character], [0, 9]);

  // An error in an imported file is shown there and mentioned here.
  const [imported] = await edit(file, 'import half from "./lib";\nprint(half(4));\n');
  assert.match(imported.message, /^in .*lib\.qiq:3:1: /);
  const there = problems.get(vscode.Uri.file(path.join(root, "check/lib.qiq")).toString());
  assert.strictEqual(there[0].range.start.line, 2);
  assert.deepStrictEqual(await edit(file, 'print("ok");\n'), []);
  assert.ok(!problems.has(vscode.Uri.file(path.join(root, "check/lib.qiq")).toString()));
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
  fs.rmSync(root, { recursive: true });
  console.log(`${tests.length - failed} of ${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
