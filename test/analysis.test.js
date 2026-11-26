// Tests for src/analysis.js and src/symbols.js. Run with any Node, or with
// the one inside VS Code:
//   ELECTRON_RUN_AS_NODE=1 code test/analysis.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const analysis = require("../src/analysis");
const { Project, parseModFile } = require("../src/symbols");

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/** Text with a | marking the cursor -> {text, offset}. */
function cursor(source) {
  const offset = source.indexOf("|");
  return { text: source.slice(0, offset) + source.slice(offset + 1), offset };
}

test("mask hides comments and literals but keeps positions", () => {
  const text = 'string s = "a { b"; // x { y\nchar c = \'}\';';
  const masked = analysis.mask(text);
  assert.strictEqual(masked.length, text.length);
  assert.ok(!masked.includes("{") && !masked.includes("}"));
  assert.strictEqual(masked.split("\n").length, 2);
  assert.ok(masked.includes('string s = "     ";'));
});

test("lexical context", () => {
  const { text, offset } = cursor('print("abc|");');
  assert.deepStrictEqual(analysis.lexicalContext(text, offset).kind, "string");
  assert.strictEqual(analysis.lexicalContext("x = 1; // a", 10).kind, "comment");
  assert.strictEqual(analysis.lexicalContext('x = "a\\"b"; y', 13).kind, "code");
});

test("block comments", () => {
  const text = 'int a = 1; /* { "\n  x }\n */ int b = 2 /* } */;';
  const masked = analysis.mask(text);
  assert.strictEqual(masked.length, text.length);
  assert.strictEqual(masked.split("\n").length, 3);
  assert.ok(!masked.includes("{") && !masked.includes("}") && !masked.includes("x"));
  assert.ok(masked.includes("int b = 2"));
  // An unclosed one runs to the end.
  assert.strictEqual(analysis.mask("a /* b\nc").trim(), "a");

  const at = (source) => analysis.lexicalContext(cursor(source).text, cursor(source).offset).kind;
  assert.strictEqual(at("/* one\n  two| */"), "comment");
  assert.strictEqual(at("/* one\n */ x|"), "code");
  assert.strictEqual(at("x = 1 /* a */ + y|"), "code");
  assert.strictEqual(at("/* never closed\n\n x|"), "comment");
  assert.strictEqual(at('s = "/* not|'), "string");
  assert.strictEqual(at('s = "/* not";\nx|'), "code");
  assert.strictEqual(at("x = 1; // /* \ny|"), "code");
});

test("raw strings", () => {
  const text = "string p = `\\d { /* \"\n x // }`; int b = 2;";
  const masked = analysis.mask(text);
  assert.strictEqual(masked.length, text.length);
  assert.strictEqual(masked.split("\n").length, 2);
  assert.ok(!masked.includes("{") && !masked.includes("}") && !masked.includes("x"));
  assert.ok(masked.includes("`; int b = 2;"));

  const at = (source) => analysis.lexicalContext(cursor(source).text, cursor(source).offset).kind;
  assert.strictEqual(at("s = `one\n  two|`"), "string");
  assert.strictEqual(at("s = `a\\`; x|"), "code");
  assert.strictEqual(at("s = `/* not a comment`; x|"), "code");
  assert.strictEqual(at("s = `a\nb`;\nx|"), "code");
});

test("f-strings", () => {
  const text = 'string s = f"a {x->y} {{ } {m["k"]:.2f} b"; int n = 1;';
  const masked = analysis.mask(text);
  assert.strictEqual(masked.length, text.length);
  assert.ok(masked.includes("x->y") && masked.includes('m[" "]'), masked);
  assert.ok(!masked.includes("a ") && !masked.includes(".2f") && !masked.includes("{{"), masked);
  assert.ok(masked.includes("; int n = 1;"));

  const at = (source) => analysis.lexicalContext(cursor(source).text, cursor(source).offset).kind;
  assert.strictEqual(at('s = f"hello | there"'), "string");
  assert.strictEqual(at('s = f"hello {us|}"'), "code");
  assert.strictEqual(at('s = f"hello {user->|"'), "code");
  assert.strictEqual(at('s = f"{m["k|"]}"'), "string");
  assert.strictEqual(at('s = f"{x}"; y|'), "code");
  assert.strictEqual(at('s = elf"x|"'), "string");
  // The ':' of `a ? b : c` isn't a format spec; one after it is.
  assert.strictEqual(at('s = f"{ok ? a : bb|}"'), "code");
  assert.strictEqual(at('s = f"{ok ? a : b:.2|f}"'), "string");
  assert.strictEqual(at('s = f"{a ?? b:.2|f}"'), "string");
  // In an expression, completion sees the variables of the code around it.
  const doc = analysis.parseDocument('function f(string name): void { print(f"{nam}"); }');
  const { text: source, offset } = cursor('function f(string name): void { print(f"{nam|}"); }');
  assert.ok(analysis.variablesAt(source, doc, offset).some((v) => v.name === "name"));
});

test("block doc comments", () => {
  const text = [
    "/**",
    " * Adds two numbers.",
    " * Returns the sum.",
    " */",
    "function add(int a, int b): int { return a + b; }",
    "/* Says hi. */",
    "function hi(): void {}",
    "// Line doc.",
    "function line(): void {}",
  ].join("\n");
  const docs = Object.fromEntries(analysis.parseDocument(text).functions.map((f) => [f.name, f.doc]));
  assert.deepStrictEqual(docs, { add: "Adds two numbers.\nReturns the sum.", hi: "Says hi.", line: "Line doc." });
});

const SAMPLE = `import Mux as WebMux, helper from "views/mux";
import File, file_get_contents from "std/file";

// A shopping basket.
class Basket {
    private Item[] items;
    public string owner;
    protected static int count = 0;

    function __construct(string owner) {
        this->owner = owner;
        this->items = [];
    }

    // Adds an item.
    function add(Item item, int quantity = 1): Basket {
        array_push(this->items, item);
        return this;
    }

    function first(): Item {
        return this->items[0];
    }

    private function total(): double {
        double sum = 0.0;
        foreach (this->items as index => item) {
            sum = sum + item->price;
        }
        return sum;
    }
}

class Item {
    public string name;
    public double price;
    public function(int): int discount;
}

abstract class Shape {
    abstract function area(): double;
    static function unit(): Shape {
        return null;
    }
}

function make(string owner, map[string, int] stock): Basket {
    Basket b = new Basket(owner);
    return b;
}

Basket basket = make("ada", {});
count = 3;
greeting = "hi";
`;

test("nullable scalar types", () => {
  const { text, offset } = cursor("?int count = null;\n?double[] ratios = [];\nfunction f(?bool flag, ?int limit = 5): ?int { return limit; }\n|");
  const doc = analysis.parseDocument(text);
  const variables = analysis.variablesAt(text, doc, offset);
  assert.strictEqual(variables.find((v) => v.name === "count").type, "?int");
  assert.strictEqual(variables.find((v) => v.name === "ratios").type, "?double[]");
  assert.deepStrictEqual(doc.functions[0].params, [{ type: "?bool", name: "flag", default: null }, { type: "?int", name: "limit", default: "5" }]);
  assert.strictEqual(doc.functions[0].returns, "?int");
});

test("generic classes and functions", () => {
  const doc = analysis.parseDocument("class Pair<A, B: Show> implements Show {\n    public A first;\n    function swap(): Pair<B, A> { return null; }\n}\nfunction first<T>(T[] items): T { return items[0]; }");
  assert.deepStrictEqual(doc.classes[0].typeParams, ["A", "B"]);
  assert.deepStrictEqual(doc.classes[0].interfaces, ["Show"]);
  assert.strictEqual(doc.classes[0].methods[0].returns, "Pair<B, A>");
  assert.deepStrictEqual(doc.functions[0].typeParams, ["T"]);
  assert.deepStrictEqual(doc.functions[0].params, [{ type: "T[]", name: "items", default: null }]);
  const { text, offset } = cursor("Box<Box<int>> nested = null;\nPair<int, string> pair = null;\n|");
  const variables = analysis.variablesAt(text, analysis.parseDocument(text), offset);
  assert.strictEqual(variables.find((v) => v.name === "nested").type, "Box<Box<int>>");
  assert.strictEqual(variables.find((v) => v.name === "pair").type, "Pair<int, string>");
  assert.deepStrictEqual(analysis.splitTypeArguments("int, Box<int, string>, map[string, int]"), ["int", "Box<int, string>", "map[string, int]"]);
});

test("generic interfaces, bounds, and methods", () => {
  const doc = analysis.parseDocument("interface Repository<T> {\n    function find(int id): T;\n}\nclass Money implements Comparable<Money>, Repository<Box<int>> {\n    function convert<U: Comparable<U>>(U x): U { return x; }\n}\nfunction largest<T: Comparable<T>>(T[] items): T { return items[0]; }");
  assert.deepStrictEqual(doc.classes.map((c) => [c.name, c.kind, c.typeParams]), [["Repository", "interface", ["T"]], ["Money", "class", []]]);
  assert.deepStrictEqual(doc.classes[1].interfaces, ["Comparable<Money>", "Repository<Box<int>>"]);
  assert.deepStrictEqual(doc.classes[1].methods[0].typeParams, ["U"]);
  assert.deepStrictEqual(doc.functions[0].typeParams, ["T"]);
});

test("enums", () => {
  const doc = analysis.parseDocument('enum Status: string implements HasLabel {\n    case Active = "active";\n    case Archived = "archived";\n    const Default = "active";\n}\nenum Suit { case Hearts; case Spades; }');
  const [status, suit] = doc.classes;
  assert.strictEqual(status.kind, "enum");
  assert.strictEqual(status.backing, "string");
  assert.ok(status.final);
  assert.deepStrictEqual(status.interfaces, ["HasLabel"]);
  const cases = status.properties.filter((p) => p.enumCase);
  assert.deepStrictEqual(cases.map((p) => [p.name, p.type, p.value]), [["Active", "Status", '"active"'], ["Archived", "Status", '"archived"']]);
  assert.deepStrictEqual(status.properties.filter((p) => !p.static).map((p) => [p.name, p.type]), [["name", "string"], ["value", "string"]]);
  assert.deepStrictEqual(status.methods.map((m) => [m.name, m.returns]), [["cases", "Status[]"], ["from", "Status"], ["tryFrom", "Status"]]);
  assert.deepStrictEqual(suit.properties.filter((p) => p.enumCase).map((p) => p.name), ["Hearts", "Spades"]);
  assert.deepStrictEqual(suit.methods.map((m) => m.name), ["cases"]);
  // `enum` as a name isn't a declaration.
  assert.strictEqual(analysis.parseDocument('string enum = "x";').classes.length, 0);
});

test("variadic parameters", () => {
  assert.deepStrictEqual(analysis.parseParameter("string ...parts"), { type: "string[]", name: "parts", default: null, variadic: true });
  assert.deepStrictEqual(analysis.parseParameter("map[string, int]... counts"), { type: "map[string, int][]", name: "counts", default: null, variadic: true });
  assert.deepStrictEqual(analysis.parseParameter("..."), { type: "...", name: "values", default: null, variadic: true });
  const doc = analysis.parseDocument("function join(string separator, string ...parts): string { return separator; }");
  assert.deepStrictEqual(doc.functions[0].params[1], { type: "string[]", name: "parts", default: null, variadic: true });
});

test("parses imports, functions, and classes", () => {
  const doc = analysis.parseDocument(SAMPLE);
  assert.deepStrictEqual(doc.imports.map((i) => i.path), ["views/mux", "std/file"]);
  assert.deepStrictEqual(doc.imports[0].names, [{ name: "Mux", alias: "WebMux" }, { name: "helper", alias: "helper" }]);
  assert.deepStrictEqual(doc.functions.map((f) => f.name), ["make"]);
  const make = doc.functions[0];
  assert.deepStrictEqual(make.params, [{ type: "string", name: "owner", default: null }, { type: "map[string, int]", name: "stock", default: null }]);
  assert.strictEqual(make.returns, "Basket");
  assert.deepStrictEqual(doc.classes.map((c) => c.name), ["Basket", "Item", "Shape"]);
  const basket = doc.classes[0];
  assert.strictEqual(basket.doc, "A shopping basket.");
  assert.deepStrictEqual(basket.properties.map((p) => [p.name, p.type, p.visibility, p.static]), [
    ["items", "Item[]", "private", false],
    ["owner", "string", "public", false],
    ["count", "int", "protected", true],
  ]);
  assert.deepStrictEqual(basket.methods.map((m) => [m.name, m.returns, m.visibility]), [
    ["__construct", "void", "public"],
    ["add", "Basket", "public"],
    ["first", "Item", "public"],
    ["total", "double", "private"],
  ]);
  assert.strictEqual(basket.methods[1].doc, "Adds an item.");
  assert.deepStrictEqual(basket.methods[1].params[1], { type: "int", name: "quantity", default: "1" });
  const item = doc.classes[1];
  assert.deepStrictEqual(item.properties.map((p) => p.type), ["string", "double", "function(int): int"]);
  const shape = doc.classes[2];
  assert.ok(shape.abstract);
  assert.deepStrictEqual(shape.methods.map((m) => [m.name, m.abstract, m.static]), [["area", true, false], ["unit", false, true]]);
});

test("variables in scope", () => {
  const doc = analysis.parseDocument(SAMPLE);
  const inTotal = SAMPLE.indexOf("sum = sum + item->price");
  const names = (offset) => Object.fromEntries(analysis.variablesAt(SAMPLE, doc, offset).map((v) => [v.name, v.type]));
  const scope = names(inTotal);
  assert.strictEqual(scope.sum, "double");
  assert.strictEqual(scope.this, "Basket");
  assert.ok("item" in scope && "index" in scope);
  assert.ok(!("basket" in scope), "top-level variables aren't visible in methods");
  const topLevel = names(SAMPLE.length);
  assert.strictEqual(topLevel.basket, "Basket");
  assert.strictEqual(topLevel.greeting, "string");
  assert.ok(!("sum" in topLevel) && !("b" in topLevel), "function variables aren't visible at the top level");
  const inMake = names(SAMPLE.indexOf("return b;"));
  assert.strictEqual(inMake.owner, "string");
  assert.strictEqual(inMake.b, "Basket");
});

test("closures see their parameters and the enclosing variables", () => {
  const source = `function run(): void {
    int base = 1;
    function(int): int f = function(int x): int {
        return x + |base;
    };
    apply(fn(string s) => s);
}`;
  const { text, offset } = cursor(source);
  const doc = analysis.parseDocument(text);
  const scope = analysis.variablesAt(text, doc, offset).map((v) => v.name);
  assert.ok(scope.includes("x") && scope.includes("base"), scope.join(","));
  const arrow = text.indexOf("=> s") + 3;
  assert.ok(analysis.variablesAt(text, doc, arrow).some((v) => v.name === "s" && v.type === "string"));
});

test("completion contexts", () => {
  const at = (source) => {
    const { text, offset } = cursor(source);
    return analysis.completionContext(text, offset);
  };
  assert.strictEqual(at("x = 1; // abc|").kind, "comment");
  assert.strictEqual(at('print("ab|");').kind, "string");
  assert.deepStrictEqual(at('import File from "std/f|";'), { kind: "importPath", prefix: "std/f", start: 18 });
  assert.deepStrictEqual(at('import Fi| from "std/file";'), { kind: "importName", path: "std/file", prefix: "Fi" });
  assert.strictEqual(at("basket->ad|").kind, "member");
  assert.strictEqual(at("basket->add(item)->|").kind, "member");
  assert.strictEqual(at("Shape::u|").kind, "static");
  assert.deepStrictEqual(at("x = new Bas|"), { kind: "new", prefix: "Bas" });
  assert.deepStrictEqual(at("class A extends B|"), { kind: "type", prefix: "B" });
  assert.deepStrictEqual(at("try { } catch (|"), { kind: "type", prefix: "" });
  assert.deepStrictEqual(at("int x = le|"), { kind: "general", prefix: "le" });
});

test("expression steps before ->", () => {
  const source = "x = new Basket(\"a\")->add(i, 2)->items[0]->";
  const masked = analysis.mask(source);
  const end = source.length - 2;
  const expression = analysis.expressionBefore(masked, end);
  assert.ok(expression);
  assert.deepStrictEqual(analysis.steps(masked, expression.start, end), [
    { kind: "new", name: "Basket" },
    { kind: "method", name: "add", args: ["i", " 2"] },
    { kind: "member", name: "items" },
    { kind: "index", index: "0" },
  ]);
});

test("calls that give type arguments", () => {
  const source = "x = wrap<Box<int>>(b)[0]->apply<string>(f)->";
  const masked = analysis.mask(source);
  const end = source.length - 2;
  const expression = analysis.expressionBefore(masked, end);
  assert.ok(expression);
  assert.strictEqual(expression.start, 4);
  assert.deepStrictEqual(analysis.steps(masked, expression.start, end), [
    { kind: "call", name: "wrap", args: ["b"], typeArgs: ["Box<int>"] },
    { kind: "index", index: "0" },
    { kind: "method", name: "apply", args: ["f"], typeArgs: ["string"] },
  ]);
  // A comparison isn't a call's type arguments.
  const compare = analysis.mask("ok = a < b && c > (d)->");
  assert.strictEqual(analysis.expressionBefore(compare, compare.length - 2), null);
  assert.strictEqual(analysis.withTypeArguments("Box<U>[]", ["U"], ["map[string, int]"]), "Box<map[string, int]>[]");
  assert.strictEqual(analysis.withTypeArguments("T", ["T"], null), "T");
  const hint = cursor("emptyList<int>(|");
  assert.strictEqual(analysis.callAt(hint.text, hint.offset).argument, 0);
  const callee = analysis.callAt(hint.text, hint.offset).expression;
  assert.deepStrictEqual(analysis.steps(analysis.mask(hint.text), callee.start, callee.end), [{ kind: "name", name: "emptyList" }]);
});

test("types of calls that give type arguments", async () => {
  const text = "function emptyList<T>(): T[] { return []; }\nclass Box<T> { public T value; function apply<U>(function(T): U f): Box<U> { return null; } }\nclass Maker { static function make<V>(): V[] { return []; } }\nBox<int> b = null;\n";
  const typeOf = async (expression) => {
    const source = text + expression;
    const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-type-arguments.qiq"), source);
    return context.typeOfExpression(text.length, source.length, source.length)?.type;
  };
  assert.strictEqual(await typeOf("emptyList<int>()"), "int[]");
  assert.strictEqual(await typeOf("b->apply<string>(f)->value"), "string");
  assert.strictEqual(await typeOf("Maker::make<Box<int>>()"), "Box<int>[]");
});

test("type parameter bounds and inferred type arguments", async () => {
  assert.deepStrictEqual(analysis.typeParamBounds("T, U: Comparable<U>, K: key"), { T: null, U: "Comparable<U>", K: "key" });
  const bindings = {};
  analysis.unifyTypes("map[K, function(V): W[]]", "map[string, function(int): bool[]]", ["K", "V", "W"], bindings);
  assert.deepStrictEqual(bindings, { K: "string", V: "int", W: "bool" });
  const text = "interface HasLength { function length(): int; }\nclass User { public string name; }\nfunction first<T>(T[] items): T { return items[0]; }\nfunction longest<T: HasLength>(T[] items): T {\n    T best = items[0];\n    return best;\n}\nclass Shelf<T: HasLength> {\n    public T[] items;\n    function top(): T { return this->items[0]; }\n}\nUser[] users = [];\n";
  const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-bounds.qiq"), text + "first(users)->name");
  const end = text.length + "first(users)->name".length;
  assert.strictEqual(context.typeOfExpression(text.length, end - "->name".length, end)?.type, "User", "T from the argument");
  assert.strictEqual(context.typeOfExpression(text.length, end, end)?.type, "string");
  const best = text.indexOf("return best;") + "return ".length;
  assert.strictEqual(context.typeOfExpression(best, best + 4, best)?.type, "HasLength", "a T is its bound");
  const items = text.indexOf("this->items[0]");
  assert.strictEqual(context.typeOfExpression(items, items + "this->items[0]".length, items)?.type, "HasLength", "so is a class's T");
  assert.strictEqual(analysis.completionContext("function f<K: ", 14).kind, "bound");
  assert.strictEqual(analysis.completionContext("class Box<T: Comparable<T>, U: Ha", 33).kind, "bound");
  assert.strictEqual(analysis.completionContext("int a = b < c ? d : ", 20).kind, "general");
});

test("tuples", async () => {
  assert.deepStrictEqual(analysis.tupleElements("(int, Box<int, string>, (bool, char))"), ["int", "Box<int, string>", "(bool, char)"]);
  assert.strictEqual(analysis.tupleElements("(function(int): int)"), null, "grouping isn't a tuple");
  const text = "class User { public string name; }\nfunction load(): (User, int) { return (null, 0); }\n(User, string) pair = null;\n(User u, int count) = load();\n(other, _) = load();\n(User, int)[] list = [];\nforeach (list as i => (who, int k)) {\n}\n";
  const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-tuples.qiq"), text + "pair[0]->name");
  const types = Object.fromEntries(context.variablesAt(text.length).map((v) => [v.name, v.type]));
  assert.deepStrictEqual(
    { pair: types.pair, u: types.u, count: types.count, other: types.other, who: types.who, k: types.k, i: types.i },
    { pair: "(User, string)", u: "User", count: "int", other: "User", who: "User", k: "int", i: "int" }
  );
  assert.ok(!("_" in types), "_ isn't a variable");
  const end = text.length + "pair[0]->name".length;
  assert.strictEqual(context.typeOfExpression(text.length, end, end)?.type, "string");
  assert.strictEqual(context.typeOfExpression(text.length, text.length + "pair[0]".length, end)?.type, "User");
});

test("std/collections", async () => {
  const text = "import ArrayList, Set, Deque from \"std/collections\";\nclass User { public string name; }\nArrayList<User> users = new ArrayList<User>();\nSet<string> tags = new Set([\"a\"]);\nforeach (users as u) {\n}\n";
  const typeOf = async (expression) => {
    const source = text + expression;
    const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-collections.qiq"), source);
    return context.typeOfExpression(text.length, source.length, source.length)?.type;
  };
  assert.strictEqual(await typeOf("users->get(0)->name"), "string");
  assert.strictEqual(await typeOf("users->filter(fn(u) => true)->first()"), "User");
  // Inherited from AbstractCollection<T>, which the file doesn't import.
  assert.strictEqual(await typeOf("users->reduce(fn(n, u) => n + 1, 0)"), "int");
  assert.strictEqual(await typeOf("users->map(fn(User u): string => u->name)"), "ArrayList<string>");
  assert.strictEqual(await typeOf("tags->union(tags)"), "Set<string>");
  const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-collections.qiq"), text);
  assert.strictEqual(context.variablesAt(text.indexOf("{\n}") + 1).find((v) => v.name === "u").type, "User");
  assert.ok(context.members(context.findClass("ArrayList<User>"), "public").methods.some((m) => m.name === "any"));
  assert.strictEqual(analysis.literalType("fn(int n, string s): bool => true"), "function(int, string): bool");
  // HashMap: a collection of (key, value) tuples, through AbstractCollection<(K, V)>.
  const maps = "import HashMap from \"std/collections\";\nclass User { public string name; }\nHashMap<string, User> users = new HashMap<string, User>();\nforeach (users as (string key, user)) {\n}\n";
  const mapContext = await new Project().contextFor(path.join(os.tmpdir(), "qiq-hashmap.qiq"), maps + "users->get(\"a\")->name");
  assert.strictEqual(mapContext.typeOfExpression(maps.length, maps.length + "users->get(\"a\")->name".length, maps.length + 30)?.type, "string");
  assert.strictEqual(mapContext.variablesAt(maps.indexOf("{\n}") + 1).find((v) => v.name === "user").type, "User");
  assert.strictEqual(analysis.literalType("fn(n) => n"), null);
});

test("std/async", async () => {
  const text = "import spawn, launch, Channel from \"std/async\";\nclass User { public string name; }\nChannel<User> users = new Channel<User>();\nforeach (users as u) {\n}\n";
  const typeOf = async (expression) => {
    const source = text + expression;
    const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-async.qiq"), source);
    return context.typeOfExpression(text.length, source.length, source.length)?.type;
  };
  assert.strictEqual(await typeOf("spawn(function(): User { return null; })"), "Task<User>");
  assert.strictEqual(await typeOf("spawn(function(): User { return null; })->await()->name"), "string");
  assert.strictEqual(await typeOf("launch(function(): void {})"), "Job");
  assert.strictEqual(await typeOf("users->receive()->name"), "string");
  const context = await new Project().contextFor(path.join(os.tmpdir(), "qiq-async.qiq"), text);
  assert.strictEqual(context.variablesAt(text.indexOf("{\n}") + 1).find((v) => v.name === "u").type, "User");
});

test("calls for parameter hints", () => {
  const { text, offset } = cursor('file_put_contents("a", "b", |);');
  const call = analysis.callAt(text, offset);
  assert.strictEqual(call.argument, 2);
  const named = cursor("http_get(url, timeout: 5|)");
  assert.strictEqual(analysis.callAt(named.text, named.offset).named, "timeout");
  assert.strictEqual(analysis.callAt("if (x|", 5), null);
  const constructor = cursor('new Basket(|');
  assert.ok(analysis.callAt(constructor.text, constructor.offset).isNew);
  const nested = cursor("f(g(1, 2), |)");
  assert.strictEqual(analysis.callAt(nested.text, nested.offset).argument, 1);
});

test("qiq.mod parsing", () => {
  const mod = parseModFile("module example.com/app\nqiq 0.1\nrequire (\n  github.com/a/b v1.0.0 // indirect\n)\nrequire x.com/y v0.2.0\nreplace x.com/y => ../y\n");
  assert.strictEqual(mod.module, "example.com/app");
  assert.deepStrictEqual([...mod.requires], [["github.com/a/b", "v1.0.0"], ["x.com/y", "v0.2.0"]]);
  assert.strictEqual(mod.replaces.get("x.com/y"), "../y");
});

test("types across files, modules, and the standard library", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qiq-vscode-"));
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  write("app/qiq.mod", "module example.com/app\nrequire github.com/ada/web v1.0.0\nreplace github.com/ada/web => ../web\n");
  write("web/qiq.mod", "module github.com/ada/web\n");
  write("web/mux.qiq", "class Base {\n    protected int hidden;\n    public string id;\n    function describe(): string { return \"\"; }\n}\nclass Mux extends Base {\n    // Routes a path.\n    function route(string path): Route { return null; }\n}\nclass Route {\n    public string pattern;\n}\nprivate function secret(): int { return 1; }\n");
  write("app/views/page.qiq", "class Page {\n    public string title;\n}\nfunction render(Page p): string { return p->title; }\n");
  const main = `import Mux as WebMux from "github.com/ada/web/mux";
import Page, render from "example.com/app/views/page";
import File from "std/file";
import Router, Request, ResponseWriter from "std/net/http/server";

WebMux mux = new WebMux();
File f = File::open("x");
Router router = new Router();
router->handle("/", function(Request r, ResponseWriter w): void {
    w->write(r->path);
});
x = mux->route("/");
y = File::open("x");
`;
  write("app/main.qiq", main);
  const project = new Project();
  const context = await project.contextFor(path.join(root, "app/main.qiq"));
  const typeAt = (expressionText) => {
    const start = main.lastIndexOf(expressionText);
    return context.typeOfExpression(start, start + expressionText.length, main.length)?.type;
  };
  assert.strictEqual(context.findClass("WebMux").name, "Mux");
  assert.strictEqual(context.findClass("Mux"), null, "only the alias is imported");
  assert.strictEqual(context.findFunction("render").returns, "string");
  assert.strictEqual(context.findClass("File").module, "std/file");
  assert.ok(context.findClass("Exception"), "exceptions are in the prelude");
  assert.strictEqual(context.findClass("Socket"), null, "std/net isn't imported");
  assert.strictEqual(typeAt("mux"), "WebMux");
  assert.strictEqual(typeAt("mux->route(\"/\")"), "Route");
  assert.strictEqual(typeAt("File::open(\"x\")"), "File");
  const mux = context.findClass("WebMux");
  const members = context.members(mux, "public");
  assert.deepStrictEqual(members.methods.map((m) => m.name), ["route", "describe"]);
  assert.deepStrictEqual(members.properties.map((p) => p.name), ["id"], "protected members are hidden outside");
  assert.strictEqual(members.methods[0].doc, "Routes a path.");
  const topScope = Object.fromEntries(context.variablesAt(main.length).map((v) => [v.name, v.type]));
  assert.strictEqual(topScope.x, "Route", "inferred from a method's return type");
  assert.strictEqual(topScope.y, "File");
  const cyclic = await project.contextFor(path.join(root, "app/cycle.qiq"), "a = b;\nb = a;\nc = a->x;\n");
  assert.ok(cyclic.variablesAt(20), "cycles don't recurse forever");
  const inside = main.indexOf("w->write") + 1;
  const scope = context.variablesAt(inside);
  assert.strictEqual(scope.find((v) => v.name === "w").type, "ResponseWriter");
  const responseWriter = context.findClass("ResponseWriter");
  assert.ok(context.members(responseWriter).methods.some((m) => m.name === "write"));
  const exports = await project.exportsOf(path.join(root, "app/main.qiq"), "github.com/ada/web/mux");
  assert.deepStrictEqual([...exports.classes.keys()], ["Base", "Mux", "Route"]);
  assert.ok(exports.functions.get("secret").private);
  fs.rmSync(root, { recursive: true });
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
