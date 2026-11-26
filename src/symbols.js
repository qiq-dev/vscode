// Names and types across files: what a document declares, what it imports
// (from other files, modules in qiq.mod, and the standard library), and the
// types of expressions. Import paths resolve the way the compiler resolves
// them (src/compiler.rs, Loader::resolve). Nothing here depends on VS Code.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const analysis = require("./analysis");

const STDLIB = require("../data/stdlib.json");

/** Where downloaded modules are kept (see src/modfile.rs, cache_directory). */
function cacheDirectory() {
  if (process.env.QIQ_MODCACHE) return process.env.QIQ_MODCACHE;
  if (process.env.XDG_CACHE_HOME) return path.join(process.env.XDG_CACHE_HOME, "qiq", "mod");
  return path.join(os.homedir(), ".cache", "qiq", "mod");
}

/** Parses qiq.mod: module path, requirements, and replacements. */
function parseModFile(text) {
  const result = { module: null, requires: new Map(), replaces: new Map() };
  let block = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    if (block && line === ")") {
      block = null;
      continue;
    }
    let [directive, ...words] = line.split(/\s+/);
    if (block) {
      words = [directive, ...words];
      directive = block;
    } else if (words[0] === "(") {
      block = directive;
      continue;
    }
    if (directive === "module") result.module = words[0];
    else if (directive === "require" && words.length >= 2) result.requires.set(words[0], words[1]);
    else if (directive === "replace" && words[1] === "=>") result.replaces.set(words[0], words[2]);
  }
  return result;
}

class Project {
  /** `readFile(path)` returns a file's text or null; by default it reads the
   * disk. The extension passes one that prefers open editors' unsaved text. */
  constructor(readFile) {
    this.readFile = readFile || ((file) => fs.promises.readFile(file, "utf8").catch(() => null));
    this.modFiles = new Map();
  }

  /** The nearest qiq.mod at or above `directory`: {root, module, requires, replaces}. */
  async modFileFor(directory) {
    if (this.modFiles.has(directory)) return this.modFiles.get(directory);
    let result = null;
    const text = await this.readFile(path.join(directory, "qiq.mod"));
    if (text !== null) {
      result = { root: directory, ...parseModFile(text) };
    } else {
      const parent = path.dirname(directory);
      result = parent !== directory ? await this.modFileFor(parent) : null;
    }
    this.modFiles.set(directory, result);
    return result;
  }

  /** Forgets cached qiq.mod files (after one changes). */
  forget() {
    this.modFiles.clear();
  }

  /** The file an import refers to: {kind: "std", path} for the standard
   * library, {kind: "file", file} otherwise, or null. */
  async resolveImport(importer, importPath) {
    if (importPath.startsWith("std/")) {
      return STDLIB.modules.includes(importPath) ? { kind: "std", path: importPath } : null;
    }
    const withExtension = (file) => (path.extname(file) ? file : file + ".qiq");
    const relative = { kind: "file", file: withExtension(path.resolve(path.dirname(importer), importPath)) };
    if (importPath.startsWith("./") || importPath.startsWith("../") || importPath.startsWith("/")) return relative;
    const mod = await this.modFileFor(path.dirname(importer));
    if (mod) {
      const within = (module) => module && (importPath === module || importPath.startsWith(module + "/"));
      const inModule = (root, module) => {
        const rest = importPath.slice(module.length).replace(/^\//, "");
        const file = rest || module.split("/").pop();
        return { kind: "file", file: withExtension(path.join(root, file)), module };
      };
      // The importer's own module: the main one, or a dependency's own qiq.mod.
      const own = await this.modFileFor(path.dirname(importer));
      if (own && within(own.module)) return inModule(own.root, own.module);
      const main = await this.mainModFor(importer);
      const required = [...(main ? main.requires.keys() : [])].filter(within).sort((a, b) => b.length - a.length)[0];
      if (required) {
        const replacement = main.replaces.get(required);
        const root = replacement
          ? path.resolve(main.root, replacement)
          : path.join(cacheDirectory(), `${required}@${main.requires.get(required)}`);
        return inModule(root, required);
      }
    }
    return relative;
  }

  /** The main module's qiq.mod for a file: for a file inside the module
   * cache, there's no way to know which project uses it, so its own. */
  async mainModFor(file) {
    return this.modFileFor(path.dirname(file));
  }

  /** The names a file or std module exports: {functions: Map, classes: Map}. */
  async exportsOf(importer, importPath) {
    const target = await this.resolveImport(importer, importPath);
    if (!target) return null;
    if (target.kind === "std") {
      const functions = new Map();
      const classes = new Map();
      for (const fn of Object.values(STDLIB.functions)) if (fn.module === target.path) functions.set(fn.name, stdlibFunction(fn));
      for (const cls of Object.values(STDLIB.classes)) if (cls.module === target.path) classes.set(cls.name, stdlibClass(cls));
      return { functions, classes, target };
    }
    const context = await this.contextFor(target.file, null, 1);
    if (!context) return null;
    const functions = new Map();
    const classes = new Map();
    for (const fn of context.document.functions) if (!fn.name.startsWith("__")) functions.set(fn.name, fileFunction(fn, target.file, context));
    for (const cls of context.document.classes) classes.set(cls.name, fileClass(cls, target.file, context));
    return { functions, classes, target };
  }

  /** A Context for a file. `text` is its contents if already known. `depth`
   * limits how far imports of imports are followed. */
  async contextFor(file, text, depth = 2) {
    if (text === null || text === undefined) text = await this.readFile(file);
    if (text === null) return null;
    const context = new Context(this, file, text);
    await context.loadImports(depth);
    return context;
  }
}

/** A stdlib function in the common shape: {name, params, returns, doc, module, origin}. */
function stdlibFunction(fn) {
  return {
    name: fn.name,
    params: fn.params.map((p) => ({ name: p.name, type: p.type, default: p.default, doc: p.doc })),
    returns: fn.returns,
    summary: fn.summary,
    doc: fn.doc,
    module: fn.module,
    origin: "stdlib",
  };
}

function stdlibClass(cls) {
  return {
    name: cls.name,
    kind: cls.kind,
    typeParams: cls.typeParams || [],
    interfaces: cls.interfaces || [],
    extends: cls.extends,
    final: cls.final,
    abstract: false,
    doc: cls.doc,
    module: cls.module,
    origin: "stdlib",
    properties: cls.properties.map((p) => ({ ...p, visibility: "public" })),
    methods: cls.methods.map((m) => ({ ...m, visibility: "public" })),
    context: null,
  };
}

function fileFunction(fn, file, context) {
  return { name: fn.name, params: fn.params, returns: fn.returns, typeParams: fn.typeParams, doc: fn.doc, private: fn.private, file, offset: fn.nameOffset, origin: "file", context };
}

/** A generic class with its type parameters replaced by `types`, in its
 * members' types: Box<int>'s get() returns int. */
function specialize(cls, types) {
  const params = cls.typeParams || [];
  if (!params.length) return cls;
  const replace = (type) =>
    type ? type.replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, (word) => (params.includes(word) ? types[params.indexOf(word)] || word : word)) : type;
  return {
    ...cls,
    name: `${cls.name}<${types.join(", ")}>`,
    typeParams: [],
    interfaces: (cls.interfaces || []).map(replace),
    extends: replace(cls.extends),
    properties: cls.properties.map((p) => ({ ...p, type: replace(p.type) })),
    methods: cls.methods.map((m) => ({ ...m, returns: replace(m.returns), params: m.params.map((p) => ({ ...p, type: replace(p.type) })) })),
  };
}

function fileClass(cls, file, context) {
  return {
    name: cls.name,
    kind: cls.kind,
    typeParams: cls.typeParams,
    backing: cls.backing,
    extends: cls.extends,
    interfaces: cls.interfaces,
    abstract: cls.abstract,
    final: cls.final,
    private: cls.private,
    doc: cls.doc,
    file,
    offset: cls.nameOffset,
    origin: "file",
    properties: cls.properties,
    methods: cls.methods,
    context,
  };
}

/** One file's view of the world: its declarations and imports. */
class Context {
  constructor(project, file, text) {
    this.project = project;
    this.file = file;
    this.text = text;
    this.document = analysis.parseDocument(text);
    /** Imported names: alias -> {kind: "function"|"class", symbol, path}. */
    this.imported = new Map();
  }

  async loadImports(depth) {
    if (depth <= 0) return;
    for (const entry of this.document.imports) {
      let exports = null;
      try {
        exports = await this.project.exportsOf(this.file, entry.path);
      } catch (error) {
        exports = null;
      }
      if (!exports) continue;
      for (const { name, alias } of entry.names) {
        const cls = exports.classes.get(name);
        const fn = exports.functions.get(name);
        if (cls) this.imported.set(alias, { kind: "class", symbol: cls, path: entry.path });
        else if (fn) this.imported.set(alias, { kind: "function", symbol: fn, path: entry.path });
      }
    }
    // Classes from other files resolve their parents in their own files.
    for (const { symbol } of this.imported.values()) {
      if (symbol.context && symbol.context !== this && !symbol.context.loaded && depth > 1) {
        symbol.context.loaded = true;
        await symbol.context.loadImports(depth - 1);
      }
    }
  }

  /** A class or interface by the name this file uses for it. */
  findClass(name) {
    if (!name) return null;
    // `Box<int>`: Box, with its type parameters replaced in its members' types.
    const generic = name.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*<(.*)>$/s);
    if (generic) {
      const cls = this.findClass(generic[1]);
      return cls ? specialize(cls, analysis.splitTypeArguments(generic[2])) : null;
    }
    const own = this.document.classes.find((cls) => cls.name === name);
    if (own) return fileClass(own, this.file, this);
    const imported = this.imported.get(name);
    if (imported && imported.kind === "class") return imported.symbol;
    const prelude = STDLIB.classes[name];
    if (prelude && !prelude.module) return stdlibClass(prelude);
    // A standard library class this file doesn't import, but that an
    // untyped callback parameter has (see closureParameterTypes), such as
    // RegexMatch in preg_replace_callback(..., fn(m) => m->...). Names the
    // file writes itself still need their import.
    if (prelude && this.inferredClasses && this.inferredClasses.has(name)) return stdlibClass(prelude);
    return null;
  }

  findFunction(name) {
    const own = this.document.functions.find((fn) => fn.name === name);
    if (own) return fileFunction(own, this.file, this);
    const imported = this.imported.get(name);
    if (imported && imported.kind === "function") return imported.symbol;
    const prelude = STDLIB.functions[name];
    if (prelude && !prelude.module) return stdlibFunction(prelude);
    return null;
  }

  /** The class whose body contains `offset`. */
  classAt(offset) {
    const cls = this.document.classes.find((c) => c.bodyStart < offset && offset < c.bodyEnd);
    return cls ? fileClass(cls, this.file, this) : null;
  }

  /** A class's members, its own first, then inherited ones it doesn't
   * override. `access` is "own" (inside the class: everything), "child"
   * (inside a subclass: public and protected), or "public". */
  members(cls, access = "public") {
    const properties = [];
    const methods = [];
    const seen = new Set();
    let current = cls;
    let level = access;
    for (let guard = 0; current && guard < 20; guard++) {
      const visible = (member) =>
        member.visibility === "public" || level === "own" || (level === "child" && member.visibility === "protected");
      for (const property of current.properties) {
        if (!seen.has("$" + property.name) && visible(property)) {
          seen.add("$" + property.name);
          properties.push({ ...property, owner: current.name });
        }
      }
      for (const method of current.methods) {
        if (!seen.has(method.name) && visible(method)) {
          seen.add(method.name);
          methods.push({ ...method, owner: current.name });
        }
      }
      // Interfaces "extend" others through their interfaces list.
      const parentName = current.extends || (current.kind === "interface" && current.interfaces && current.interfaces[0]);
      const resolver = current.context || this;
      current = parentName ? resolver.findClass(parentName) : null;
      if (level === "own") level = "child";
    }
    return { properties, methods };
  }

  /** The variables visible at `offset`. */
  variablesAt(offset) {
    return analysis.variablesAt(this.text, this.document, offset, {
      typeOfText: (text, at) => this.typeOfText(text, at),
      closureParameterTypes: (at) => this.closureParameterTypes(at),
      iteratedType: (type) => this.iteratedType(type),
    });
  }

  /** The T of the Iterable<T> or Iterator<T> that `type` is or implements
   * (through its interfaces and parents), for foreach; null if none. */
  iteratedType(type) {
    const seen = new Set();
    const pending = [type];
    while (pending.length) {
      const name = pending.pop();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const iterable = name.match(/^(?:Iterable|Iterator)\s*<(.*)>$/s);
      if (iterable) {
        // Its class needs no import: the code doesn't name it.
        const element = iterable[1].trim();
        this.inferredClasses = this.inferredClasses || new Set();
        this.inferredClasses.add(element.replace(/(\[\])+$/, "").replace(/<.*$/, ""));
        return element;
      }
      // A standard library class reached through a method's return type
      // (db->cursor(...)) needs no import.
      const cls = this.findClass(name) || (STDLIB.classes[name] ? stdlibClass(STDLIB.classes[name]) : null);
      if (!cls) continue;
      pending.push(...(cls.interfaces || []));
      if (cls.extends) pending.push(cls.extends);
    }
    return null;
  }

  /** The parameter types (as written, such as "Item") expected of the
   * anonymous function that starts at `start`: those of the function type
   * of the parameter it's passed to, or of the variable it's declared as.
   * Null if they can't be told. */
  closureParameterTypes(start) {
    if (this.inferring >= 3) return null;
    this.inferring = (this.inferring || 0) + 1;
    try {
      const type = this.expectedFunctionType(start);
      if (!type || !/^function\s*\(/.test(type)) return null;
      const open = type.indexOf("(");
      const close = analysis.matching(type, open);
      const types = analysis.splitTopLevel(type.slice(open + 1, close)).map((t) => analysis.normalizeType(t.trim())).filter((t) => t !== "");
      // Their classes need no import: the code doesn't name them.
      this.inferredClasses = this.inferredClasses || new Set();
      for (const t of types) this.inferredClasses.add(t.replace(/(\[\])+$/, ""));
      return types;
    } finally {
      this.inferring--;
    }
  }

  /** The type expected at `offset`: a call argument's parameter type, or a
   * declared function-typed variable's type. */
  expectedFunctionType(offset) {
    const before = this.document.masked.slice(Math.max(0, offset - 300), offset);
    const declared = before.match(/(function\s*\(.*\)\s*:\s*[^=;{]+?)\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*$/s);
    if (declared) return analysis.normalizeType(declared[1]);
    const call = analysis.callAt(this.text, offset);
    if (!call) return null;
    const params = this.callParameters(call, offset);
    if (!params) return null;
    const last = params[params.length - 1];
    const param = call.named ? params.find((p) => p.name === call.named) : params[call.argument] || (last && last.variadic ? last : null);
    if (!param) return null;
    // Each value for a variadic parameter is one of the array's elements.
    const type = param.variadic && param.type !== "..." ? param.type.replace(/\[\]$/, "") : param.type;
    return this.substituteTypeParameters(type, params, call, offset);
  }

  /** For a built-in such as array_filter, whose parameters are written
   * with placeholders (T[], function(T): bool, map[K, V], U), `type` with
   * each placeholder replaced by what the call's arguments make it: T and
   * K and V from the array or map, U from array_reduce's initial value. */
  substituteTypeParameters(type, params, call, offset) {
    if (!/\b[TUKVW]\b/.test(type || "")) return type;
    const masked = this.document.masked;
    const close = analysis.matching(masked, call.open);
    const argumentTexts = analysis.splitTopLevel(this.text.slice(call.open + 1, close));
    const bindings = {};
    params.forEach((p, index) => {
      const text = argumentTexts[index];
      if (!text || !p.type) return;
      const argumentType = this.typeOfText(text, offset);
      if (!argumentType) return;
      if (/^T\s*\[\s*\]$/.test(p.type)) bindings.T = analysis.elementTypes(argumentType)[1];
      const map = p.type.match(/^map\s*\[\s*K\s*,\s*V\s*\]$/);
      if (map) [bindings.K, bindings.V] = analysis.elementTypes(argumentType);
      if (/^U$/.test(p.type.trim())) bindings.U = argumentType;
    });
    return type.replace(/\b([TUKVW])\b/g, (letter) => bindings[letter] || letter);
  }

  /** The parameters of the function, method, or constructor `call` (from
   * analysis.callAt) calls, or null. */
  callParameters(call, offset) {
    const parts = analysis.steps(this.document.masked, call.expression.start, call.expression.end);
    if (!parts || !parts.length) return null;
    const last = parts[parts.length - 1];
    if (call.isNew || last.kind === "new") {
      const cls = this.findClass(last.name);
      const constructor = cls && this.members(cls, "own").methods.find((m) => m.name === "__construct");
      return constructor ? constructor.params : null;
    }
    if (parts.length === 1 && (last.kind === "name" || last.kind === "call")) {
      const variable = this.variablesAt(offset).find((v) => v.name === last.name);
      if (variable && variable.type && variable.type.startsWith("function")) {
        const open = variable.type.indexOf("(");
        const close = analysis.matching(variable.type, open);
        return analysis.splitTopLevel(variable.type.slice(open + 1, close)).map((t, index) => ({ name: `arg${index + 1}`, type: t.trim() }));
      }
      const fn = this.findFunction(last.name);
      return fn ? fn.params : null;
    }
    if (last.kind === "member" || last.kind === "staticMember") {
      const receiver = this.typeOfSteps(parts.slice(0, -1), offset);
      if (!receiver || !receiver.type) return null;
      const cls = receiver.context.findClass(receiver.type) || this.findClass(receiver.type);
      const method = cls && this.members(cls, "own").methods.find((m) => m.name === last.name);
      return method ? method.params : null;
    }
    return null;
  }

  /** The type of the expression text (as written at `offset`). */
  typeOfText(text, offset) {
    const literal = analysis.literalType(text);
    if (literal) return literal;
    const masked = analysis.mask(text);
    const end = masked.replace(/\s+$/, "").length;
    const expression = analysis.expressionBefore(masked, end);
    if (!expression || masked.slice(0, expression.start).trim() !== "") return null;
    // Inferring a variable's type can need other variables' types; a few
    // levels are plenty, and stop cycles such as `a = b; b = a;`.
    if (this.inferring >= 3) return null;
    this.inferring = (this.inferring || 0) + 1;
    try {
      const found = this.typeOfSteps(analysis.steps(masked, expression.start, end), offset);
      return found && !found.static ? found.type : null;
    } finally {
      this.inferring--;
    }
  }

  /** The type of the expression in this file's text between start and end:
   * {type, context, static} where `static` means the expression names a
   * class (before ::). */
  typeOfExpression(start, end, offset) {
    const parts = analysis.steps(this.document.masked, start, end);
    return this.typeOfSteps(parts, offset);
  }

  typeOfSteps(parts, offset) {
    if (!parts || parts.length === 0) return null;
    let current = null; // {type, context, static}
    const [first, ...rest] = parts;
    const enclosing = this.classAt(offset);
    if (first.kind === "literal") current = { type: first.type, context: this };
    else if (first.kind === "new") current = { type: first.name, context: this };
    else if (first.kind === "name") {
      const name = first.name;
      if (name === "this" && enclosing) current = { type: enclosing.name, context: this };
      else if ((name === "self" || name === "static") && enclosing) current = { type: enclosing.name, context: this, static: true };
      else if (name === "parent" && enclosing && enclosing.extends) current = { type: enclosing.extends, context: this, static: true, parent: true };
      else {
        const variable = this.variablesAt(offset).find((v) => v.name === name);
        if (variable && variable.type) current = { type: variable.type, context: this };
        else if (this.findClass(name)) current = { type: name, context: this, static: true };
      }
    } else if (first.kind === "call") {
      const variable = this.variablesAt(offset).find((v) => v.name === first.name);
      if (variable && variable.type) current = { type: analysis.functionReturnType(variable.type), context: this };
      else {
        const fn = this.findFunction(first.name);
        if (fn) current = { type: analysis.withTypeArguments(fn.returns, fn.typeParams, first.typeArgs), context: fn.context || this };
      }
    }
    for (const step of rest) {
      if (!current || !current.type) return null;
      if (step.kind === "index") {
        current = { type: analysis.elementTypes(current.type)[1], context: current.context };
        continue;
      }
      if (step.kind === "invoke") {
        current = { type: analysis.functionReturnType(current.type), context: current.context };
        continue;
      }
      // `X::class` and `value::class`: the class's name.
      if (step.kind === "staticMember" && step.name === "class") {
        current = { type: "string", context: current.context };
        continue;
      }
      const cls = current.context.findClass(current.type) || this.findClass(current.type);
      if (!cls) return null;
      const access = enclosing && enclosing.name === cls.name ? "own" : "public";
      const { properties, methods } = this.members(cls, access === "own" ? "own" : current.parent ? "child" : "public");
      const context = cls.context || current.context;
      if (step.kind === "member" || step.kind === "staticMember") {
        const property = properties.find((p) => p.name === step.name);
        current = property ? { type: property.type, context } : null;
      } else {
        const method = methods.find((m) => m.name === step.name);
        if (!method) return null;
        const returns = method.returns === "static" ? cls.name : analysis.withTypeArguments(method.returns, method.typeParams, step.typeArgs);
        current = { type: returns, context };
      }
    }
    return current;
  }
}

module.exports = { Project, Context, STDLIB, parseModFile, cacheDirectory, stdlibFunction, stdlibClass };
