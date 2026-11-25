// The qiq extension: completion, hovers, parameter hints, go to definition,
// the outline, and compile errors, built on src/analysis.js, src/symbols.js,
// and src/diagnostics.js.
"use strict";

const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const analysis = require("./analysis");
const diagnostics = require("./diagnostics");
const { Project, STDLIB, stdlibFunction, stdlibClass, cacheDirectory } = require("./symbols");

const LANGUAGE = "qiq";

/** Reads a file, preferring an open editor's unsaved text. */
function readFile(file) {
  const open = vscode.workspace.textDocuments.find((document) => document.uri.fsPath === file);
  if (open) return Promise.resolve(open.getText());
  return fs.promises.readFile(file, "utf8").catch(() => null);
}

const project = new Project(readFile);

/** Contexts are rebuilt when a document changes; one per version. */
const contexts = new Map();
async function contextFor(document) {
  const key = document.uri.toString();
  const cached = contexts.get(key);
  if (cached && cached.version === document.version) return cached.context;
  const context = await project.contextFor(document.uri.fsPath, document.getText());
  contexts.set(key, { version: document.version, context });
  return context;
}

// ---------------------------------------------------------------------------
// Formatting signatures and docs

function parameterText(p) {
  // `...`: any number of values for a query's placeholders (std/sql).
  if (p.variadic && p.type === "...") return `...${p.name}`;
  // `string ...parts`, whose type is string[].
  if (p.variadic) return `${p.type.replace(/\[\]$/, "")} ...${p.name}`;
  return `${p.type} ${p.name}${p.default !== null && p.default !== undefined ? ` = ${p.default}` : ""}`;
}

function signature(name, params, returns) {
  return `${name}(${params.map(parameterText).join(", ")})${returns && returns !== "void" ? `: ${returns}` : returns === "void" ? ": void" : ""}`;
}

function functionDocs(fn) {
  const markdown = new vscode.MarkdownString();
  markdown.appendCodeblock(`function ${signature(fn.name, fn.params, fn.returns)}`, LANGUAGE);
  if (fn.summary && fn.doc && !fn.doc.startsWith(fn.summary)) markdown.appendMarkdown(fn.summary + "\n\n");
  if (fn.doc) markdown.appendMarkdown(fn.doc + "\n\n");
  if (fn.module) markdown.appendMarkdown(`Import with \`import ${fn.name} from "${fn.module}";\``);
  return markdown;
}

function classDocs(cls) {
  const markdown = new vscode.MarkdownString();
  const keyword = cls.kind === "interface" ? "interface" : `${cls.abstract ? "abstract " : ""}${cls.final ? "final " : ""}class`;
  const parents = (cls.extends ? ` extends ${cls.extends}` : "") + (cls.interfaces && cls.interfaces.length && cls.kind !== "interface" ? ` implements ${cls.interfaces.join(", ")}` : "");
  markdown.appendCodeblock(`${keyword} ${cls.name}${parents}`, LANGUAGE);
  if (cls.doc) markdown.appendMarkdown(cls.doc + "\n\n");
  if (cls.module) markdown.appendMarkdown(`Import with \`import ${cls.name} from "${cls.module}";\``);
  return markdown;
}

function memberDocs(member, owner) {
  const markdown = new vscode.MarkdownString();
  if (member.params) {
    const modifiers = `${member.visibility && member.visibility !== "public" ? member.visibility + " " : ""}${member.static ? "static " : ""}`;
    markdown.appendCodeblock(`${modifiers}function ${owner}::${signature(member.name, member.params, member.returns)}`, LANGUAGE);
  } else if (member.constant) {
    markdown.appendCodeblock(`${member.visibility && member.visibility !== "public" ? member.visibility + " " : ""}const ${member.type} ${owner}::${member.name} = ${member.value}`, LANGUAGE);
  } else {
    markdown.appendCodeblock(`${member.visibility || "public"} ${member.static ? "static " : ""}${member.readonly ? "readonly " : ""}${member.type} ${owner}::${member.name}`, LANGUAGE);
  }
  if (member.doc) markdown.appendMarkdown(member.doc);
  return markdown;
}

// ---------------------------------------------------------------------------
// Auto-import

/** An edit adding `name` to the imports from `modulePath`: into an existing
 * `import ... from "modulePath";`, or as a new import line. */
function importEdit(document, context, name, modulePath) {
  const existing = context.document.imports.find((entry) => entry.path === modulePath);
  if (existing) {
    const lineText = document.getText(new vscode.Range(document.positionAt(existing.start), document.positionAt(existing.end)));
    const from = lineText.search(/\s+from\s*"/);
    return vscode.TextEdit.insert(document.positionAt(existing.start + from), `, ${name}`);
  }
  const line = `import ${name} from "${modulePath}";`;
  const imports = context.document.imports;
  if (imports.length) {
    const last = document.positionAt(imports[imports.length - 1].end);
    return vscode.TextEdit.insert(last, "\n" + line);
  }
  // After the comments at the top of the file, // lines or /* */ blocks.
  let lineNumber = 0;
  while (lineNumber < document.lineCount) {
    const text = document.lineAt(lineNumber).text.trim();
    if (text.startsWith("//")) {
      lineNumber++;
    } else if (text.startsWith("/*")) {
      let closing = lineNumber;
      const closes = (line) => (line === lineNumber ? text.slice(2) : document.lineAt(line).text).includes("*/");
      while (closing < document.lineCount && !closes(closing)) closing++;
      if (closing >= document.lineCount) break;
      lineNumber = closing + 1;
    } else {
      break;
    }
  }
  const next = lineNumber < document.lineCount ? document.lineAt(lineNumber).text.trim() : "";
  return vscode.TextEdit.insert(new vscode.Position(lineNumber, 0), line + "\n" + (next === "" ? "" : "\n"));
}

// ---------------------------------------------------------------------------
// Completion items

const Kind = vscode.CompletionItemKind;

function callSnippet(name, params) {
  return params.length ? new vscode.SnippetString(`${name}($0)`) : new vscode.SnippetString(`${name}()`);
}

const triggerHints = { command: "editor.action.triggerParameterHints", title: "Parameter hints" };

function functionItem(fn, sortGroup, extra = {}) {
  const item = new vscode.CompletionItem(
    { label: fn.name, detail: `(${fn.params.map(parameterText).join(", ")})`, description: extra.description || (fn.returns !== "void" ? fn.returns : "") },
    Kind.Function
  );
  item.insertText = callSnippet(fn.name, fn.params);
  item.command = fn.params.length ? triggerHints : undefined;
  item.documentation = functionDocs(fn);
  item.sortText = sortGroup + fn.name;
  Object.assign(item, extra.item || {});
  return item;
}

function classItem(cls, sortGroup, options = {}) {
  const item = new vscode.CompletionItem(
    { label: options.alias || cls.name, description: options.description || (cls.module ? cls.module : cls.kind === "interface" ? "interface" : "") },
    cls.kind === "interface" ? Kind.Interface : Kind.Class
  );
  item.documentation = classDocs(cls);
  item.sortText = sortGroup + (options.alias || cls.name);
  return item;
}

/** Functions and classes from the standard library that need an import,
 * with an edit that adds it. */
function stdlibItems(document, context, wanted) {
  const items = [];
  const imported = new Set(context.imported.keys());
  const declared = new Set([...context.document.functions.map((f) => f.name), ...context.document.classes.map((c) => c.name)]);
  if (wanted.functions) {
    for (const fn of Object.values(STDLIB.functions)) {
      if (!fn.module || imported.has(fn.name) || declared.has(fn.name)) continue;
      const item = functionItem(context.findFunction(fn.name) || stdlibFunction(fn), "4", { description: fn.module });
      item.additionalTextEdits = [importEdit(document, context, fn.name, fn.module)];
      items.push(item);
    }
  }
  if (wanted.classes) {
    for (const cls of Object.values(STDLIB.classes)) {
      if (!cls.module || imported.has(cls.name) || declared.has(cls.name)) continue;
      const item = classItem(stdlibClass(cls), "4");
      item.additionalTextEdits = [importEdit(document, context, cls.name, cls.module)];
      if (wanted.construct) {
        item.insertText = new vscode.SnippetString(`${cls.name}($0)`);
        item.command = triggerHints;
      }
      items.push(item);
    }
  }
  return items;
}

/** Every class this file can name: its own, imported, and the prelude's. */
function knownClasses(context) {
  const result = new Map();
  for (const cls of Object.values(STDLIB.classes)) if (!cls.module) result.set(cls.name, context.findClass(cls.name));
  for (const [alias, entry] of context.imported) if (entry.kind === "class") result.set(alias, entry.symbol);
  for (const cls of context.document.classes) result.set(cls.name, context.findClass(cls.name));
  return result;
}

function knownFunctions(context) {
  const result = new Map();
  for (const fn of Object.values(STDLIB.functions)) if (!fn.module) result.set(fn.name, context.findFunction(fn.name));
  for (const [alias, entry] of context.imported) if (entry.kind === "function") result.set(alias, { ...entry.symbol, name: alias });
  for (const fn of context.document.functions) result.set(fn.name, context.findFunction(fn.name));
  return result;
}

function generalItems(document, context, offset) {
  const items = [];
  for (const variable of context.variablesAt(offset)) {
    const item = new vscode.CompletionItem({ label: variable.name, description: variable.type || "" }, variable.name === "this" ? Kind.Keyword : Kind.Variable);
    item.sortText = "0" + variable.name;
    items.push(item);
  }
  for (const [name, fn] of knownFunctions(context)) {
    if (name.startsWith("__")) continue;
    items.push(functionItem(fn, fn.origin === "file" ? "1" : "3"));
  }
  for (const [alias, cls] of knownClasses(context)) items.push(classItem(cls, cls.origin === "file" ? "1" : "3", { alias }));
  items.push(...stdlibItems(document, context, { functions: true, classes: true }));
  for (const keyword of analysis.KEYWORDS) {
    const item = new vscode.CompletionItem(keyword, Kind.Keyword);
    item.sortText = "2" + keyword;
    items.push(item);
  }
  for (const type of analysis.PRIMITIVES) {
    const item = new vscode.CompletionItem(type, Kind.TypeParameter);
    item.sortText = "2" + type;
    items.push(item);
  }
  return items;
}

/** The access a position has to a class's members: "own", "child", or "public". */
function accessTo(context, cls, offset) {
  const enclosing = context.classAt(offset);
  if (!enclosing) return "public";
  if (enclosing.name === cls.name) return "own";
  let current = enclosing;
  for (let guard = 0; current && guard < 20; guard++) {
    if (current.name === cls.name) return "child";
    current = current.extends ? (current.context || context).findClass(current.extends) : null;
  }
  return "public";
}

/** `::class`, the name of a class (or of an object's class). */
function classNameItem() {
  const item = new vscode.CompletionItem({ label: "class", description: "string" }, Kind.Keyword);
  item.documentation = new vscode.MarkdownString("The class's name, as a string: `Circle::class` is `\"Circle\"`. On a value, the name of its object's class when the program runs.");
  item.sortText = "2class";
  return item;
}

function memberItems(context, found, offset, wantStatic) {
  if (!found || !found.type) return [];
  const cls = found.context.findClass(found.type) || context.findClass(found.type);
  if (!cls) return [];
  const access = found.parent ? "child" : accessTo(context, cls, offset);
  const { properties, methods } = context.members(cls, access);
  const items = [];
  // `parent::` calls the parent's methods, static or not.
  const include = (member) => (found.parent ? true : wantStatic ? member.static : !member.static);
  // `Class::class` is the class's name.
  if (wantStatic && !found.parent) items.push(classNameItem());
  for (const property of properties) {
    if (!include(property)) continue;
    const item = new vscode.CompletionItem({ label: property.name, description: property.type }, property.constant ? Kind.Constant : Kind.Field);
    item.documentation = memberDocs(property, property.owner);
    item.sortText = (property.owner === cls.name ? "0" : "1") + property.name;
    items.push(item);
  }
  for (const method of methods) {
    if (!include(method)) continue;
    if (method.name === "__construct" && !found.parent) continue;
    const item = new vscode.CompletionItem(
      { label: method.name, detail: `(${method.params.map(parameterText).join(", ")})`, description: method.returns !== "void" ? method.returns : "" },
      Kind.Method
    );
    item.insertText = callSnippet(method.name, method.params);
    item.command = method.params.length ? triggerHints : undefined;
    item.documentation = memberDocs(method, method.owner);
    item.sortText = (method.owner === cls.name ? "0" : "1") + method.name;
    items.push(item);
  }
  return items;
}

async function importPathItems(document, context, completion, position) {
  const items = [];
  const prefix = completion.prefix;
  const range = new vscode.Range(document.positionAt(completion.start), position);
  const add = (label, kind, detail, retrigger) => {
    const item = new vscode.CompletionItem({ label, description: detail || "" }, kind);
    item.range = range;
    item.insertText = label;
    item.filterText = label;
    if (retrigger) item.command = { command: "editor.action.triggerSuggest", title: "Suggest" };
    items.push(item);
  };
  for (const module of STDLIB.modules) if (module.startsWith(prefix.slice(0, 4))) add(module, Kind.Module, "standard library");
  const mod = await project.modFileFor(path.dirname(document.uri.fsPath));
  const roots = [];
  if (mod) {
    if (mod.module) roots.push({ module: mod.module, root: mod.root, detail: "this module" });
    for (const [required, version] of mod.requires) {
      const replacement = mod.replaces.get(required);
      const root = replacement ? path.resolve(mod.root, replacement) : path.join(cacheDirectory(), `${required}@${version}`);
      roots.push({ module: required, root, detail: `${version}${replacement ? " (replaced)" : ""}` });
    }
  }
  // Files and directories under a module root or relative to this file.
  let directory = null;
  let base = "";
  const root = roots.find((r) => prefix === r.module || prefix.startsWith(r.module + "/"));
  if (root) {
    const rest = prefix.slice(root.module.length).replace(/^\//, "");
    base = root.module + "/" + rest.slice(0, rest.lastIndexOf("/") + 1);
    directory = path.join(root.root, rest.slice(0, rest.lastIndexOf("/") + 1));
  } else {
    for (const r of roots) add(r.module, Kind.Module, r.detail);
    if (!prefix.startsWith("std/")) {
      base = prefix.slice(0, prefix.lastIndexOf("/") + 1);
      directory = path.resolve(path.dirname(document.uri.fsPath), base || ".");
    }
  }
  if (directory) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) add(base + entry.name + "/", Kind.Folder, "", true);
      else if (entry.name.endsWith(".qiq") && full !== document.uri.fsPath) add(base + entry.name.slice(0, -4), Kind.File);
    }
  }
  return items;
}

async function importNameItems(document, context, completion) {
  if (!completion.path) return [];
  const exports = await project.exportsOf(document.uri.fsPath, completion.path).catch(() => null);
  if (!exports) return [];
  const mod = await project.modFileFor(path.dirname(document.uri.fsPath));
  const sameModule = !exports.target.module || (mod && mod.module === exports.target.module);
  const items = [];
  for (const [name, fn] of exports.functions) {
    if (name.startsWith("__") || (fn.private && !sameModule)) continue;
    const item = functionItem(fn, "0");
    item.insertText = name;
    item.command = undefined;
    items.push(item);
  }
  for (const [name, cls] of exports.classes) {
    if (cls.private && !sameModule) continue;
    items.push(classItem(cls, "0"));
  }
  return items;
}

const completionProvider = {
  async provideCompletionItems(document, position, token, completionContext) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    // ">" and ":" only start completion as part of "->" and "::".
    const trigger = completionContext.triggerCharacter;
    if (trigger === ">" && text[offset - 2] !== "-") return undefined;
    if (trigger === ":" && text[offset - 2] !== ":") return undefined;
    const completion = analysis.completionContext(text, offset);
    if (completion.kind === "comment" || completion.kind === "string") return undefined;
    if ((trigger === '"' || trigger === "/") && completion.kind !== "importPath") return undefined;
    const context = await contextFor(document);
    switch (completion.kind) {
      case "importPath":
        return importPathItems(document, context, completion, position);
      case "importName":
        return importNameItems(document, context, completion);
      case "importFrom":
        return [];
      case "member": {
        const found = context.typeOfExpression(completion.expression.start, completion.expression.end, offset);
        return memberItems(context, found && !found.static ? found : null, offset, false);
      }
      case "static": {
        const found = context.typeOfExpression(completion.expression.start, completion.expression.end, offset);
        // `value::` only has `class`: the name of its object's class.
        if (found && !found.static && found.type) return [classNameItem()];
        return memberItems(context, found && found.static ? found : null, offset, true);
      }
      case "new": {
        const items = [];
        for (const [alias, cls] of knownClasses(context)) {
          if (cls.kind === "interface" || cls.abstract) continue;
          const item = classItem(cls, cls.origin === "file" ? "0" : "1", { alias });
          item.insertText = new vscode.SnippetString(`${alias}($0)`);
          item.command = triggerHints;
          items.push(item);
        }
        items.push(...stdlibItems(document, context, { classes: true, construct: true }));
        return items;
      }
      case "type": {
        const items = [];
        for (const [alias, cls] of knownClasses(context)) items.push(classItem(cls, "0", { alias }));
        items.push(...stdlibItems(document, context, { classes: true }));
        return items;
      }
      default:
        return generalItems(document, context, offset);
    }
  },
};

// ---------------------------------------------------------------------------
// Hovers, parameter hints, definitions, and the outline

/** What the word at `position` names: {kind, symbol, owner?}. */
async function symbolAt(document, position) {
  const range = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
  if (!range) return null;
  const text = document.getText();
  const start = document.offsetAt(range.start);
  const end = document.offsetAt(range.end);
  if (analysis.lexicalContext(text, start).kind !== "code") return null;
  const word = text.slice(start, end);
  const context = await contextFor(document);
  const masked = context.document.masked;
  const before = masked.slice(0, start).replace(/\s+$/, "");
  if (before.endsWith("->") || before.endsWith("::")) {
    const expression = analysis.expressionBefore(masked, before.length - 2);
    if (!expression) return null;
    const found = context.typeOfExpression(expression.start, expression.end, start);
    if (!found || !found.type) return null;
    const cls = found.context.findClass(found.type) || context.findClass(found.type);
    if (!cls) return null;
    const { properties, methods } = context.members(cls, "own");
    const member = methods.find((m) => m.name === word) || properties.find((p) => p.name === word);
    if (!member) return null;
    const owner = (member.owner && (cls.context || context).findClass(member.owner)) || cls;
    return { kind: member.params ? "method" : "property", symbol: member, owner, range };
  }
  const variable = context.variablesAt(start).find((v) => v.name === word);
  const isCall = /^\s*\(/.test(masked.slice(end));
  if (variable && !(isCall && !variable.type?.startsWith("function"))) return { kind: "variable", symbol: variable, range, context };
  const fn = context.findFunction(word);
  if (fn) return { kind: "function", symbol: fn, range };
  const cls = context.findClass(word);
  if (cls) return { kind: "class", symbol: cls, range };
  // A standard library name that isn't imported yet.
  if (STDLIB.functions[word]) return { kind: "function", symbol: stdlibFunction(STDLIB.functions[word]), range };
  if (STDLIB.classes[word]) return { kind: "class", symbol: stdlibClass(STDLIB.classes[word]), range };
  return null;
}

const hoverProvider = {
  async provideHover(document, position) {
    const found = await symbolAt(document, position);
    if (!found) return null;
    switch (found.kind) {
      case "function":
        return new vscode.Hover(functionDocs(found.symbol), found.range);
      case "class":
        return new vscode.Hover(classDocs(found.symbol), found.range);
      case "method":
      case "property":
        return new vscode.Hover(memberDocs(found.symbol, found.owner.name), found.range);
      case "variable": {
        const markdown = new vscode.MarkdownString();
        markdown.appendCodeblock(`${found.symbol.type || "(type not known)"} ${found.symbol.name}`, LANGUAGE);
        return new vscode.Hover(markdown, found.range);
      }
    }
    return null;
  },
};

/** Parameters of a function type: "function(int, string): bool". */
function functionTypeParams(type) {
  const open = type.indexOf("(");
  const close = analysis.matching(type, open);
  return analysis.splitTopLevel(type.slice(open + 1, close)).map((t, index) => ({ type: t.trim(), name: `arg${index + 1}`, default: null }));
}

const signatureProvider = {
  async provideSignatureHelp(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    if (analysis.lexicalContext(text, offset).kind !== "code") return null;
    const call = analysis.callAt(text, offset);
    if (!call) return null;
    const context = await contextFor(document);
    const masked = context.document.masked;
    const parts = analysis.steps(masked, call.expression.start, call.expression.end);
    if (!parts || !parts.length) return null;
    let name;
    let params;
    let returns;
    let doc;
    const last = parts[parts.length - 1];
    if (call.isNew || last.kind === "new") {
      const className = last.name;
      const cls = context.findClass(className) || (STDLIB.classes[className] && stdlibClass(STDLIB.classes[className]));
      if (!cls) return null;
      const constructor = context.members(cls, "own").methods.find((m) => m.name === "__construct");
      name = className;
      params = constructor ? constructor.params : [];
      returns = null;
      doc = constructor && constructor.doc;
    } else if (parts.length === 1 && (last.kind === "name" || last.kind === "call")) {
      const variable = context.variablesAt(offset).find((v) => v.name === last.name);
      if (variable && variable.type && variable.type.startsWith("function")) {
        name = last.name;
        params = functionTypeParams(variable.type);
        returns = analysis.functionReturnType(variable.type);
      } else {
        const fn = context.findFunction(last.name) || (STDLIB.functions[last.name] && stdlibFunction(STDLIB.functions[last.name]));
        if (!fn) return null;
        name = fn.name;
        params = fn.params;
        returns = fn.returns;
        doc = fn.summary || fn.doc;
      }
    } else if (last.kind === "member" || last.kind === "staticMember") {
      // A method call: everything before the last step is the object.
      const receiver = context.typeOfSteps(parts.slice(0, -1), offset);
      if (!receiver || !receiver.type) return null;
      const cls = receiver.context.findClass(receiver.type) || context.findClass(receiver.type);
      if (!cls) return null;
      const method = context.members(cls, "own").methods.find((m) => m.name === last.name);
      if (!method) return null;
      name = `${cls.name}::${method.name}`;
      params = method.params;
      returns = method.returns;
      doc = method.doc;
    } else {
      return null;
    }
    let label = `${name}(`;
    const parameterInfos = params.map((p, index) => {
      const textOf = parameterText(p);
      const start = label.length;
      label += textOf + (index < params.length - 1 ? ", " : "");
      return new vscode.ParameterInformation([start, start + textOf.length], p.doc ? new vscode.MarkdownString(p.doc) : undefined);
    });
    label += ")" + (returns ? `: ${returns}` : "");
    const info = new vscode.SignatureInformation(label, doc ? new vscode.MarkdownString(doc) : undefined);
    info.parameters = parameterInfos;
    const help = new vscode.SignatureHelp();
    help.signatures = [info];
    help.activeSignature = 0;
    const namedIndex = call.named ? params.findIndex((p) => p.name === call.named) : -1;
    help.activeParameter = namedIndex >= 0 ? namedIndex : Math.min(call.argument, Math.max(0, params.length - 1));
    return help;
  },
};

const definitionProvider = {
  async provideDefinition(document, position) {
    const found = await symbolAt(document, position);
    if (!found) return null;
    const locate = (file, offset, text) => {
      if (offset === undefined || !file) return null;
      const lines = text.slice(0, offset).split("\n");
      return new vscode.Location(vscode.Uri.file(file), new vscode.Position(lines.length - 1, lines[lines.length - 1].length));
    };
    if (found.kind === "function" || found.kind === "class") {
      const symbol = found.symbol;
      if (symbol.origin !== "file") return null;
      return locate(symbol.file, symbol.offset, symbol.context.text);
    }
    if (found.kind === "method" || found.kind === "property") {
      const owner = found.owner;
      if (owner.origin !== "file") return null;
      const offset = found.symbol.nameOffset !== undefined ? found.symbol.nameOffset : found.symbol.offset;
      return locate(owner.file, offset, owner.context.text);
    }
    return null;
  },
};

const symbolProvider = {
  provideDocumentSymbols(document) {
    const doc = analysis.parseDocument(document.getText());
    const range = (start, end) => new vscode.Range(document.positionAt(start), document.positionAt(Math.max(start, end)));
    const symbols = [];
    for (const fn of doc.functions) {
      const end = fn.bodyEnd > 0 ? fn.bodyEnd + 1 : fn.nameOffset + fn.name.length;
      symbols.push(new vscode.DocumentSymbol(fn.name, `(${fn.params.map(parameterText).join(", ")}): ${fn.returns}`, vscode.SymbolKind.Function, range(fn.start, end), range(fn.nameOffset, fn.nameOffset + fn.name.length)));
    }
    for (const cls of doc.classes) {
      const symbol = new vscode.DocumentSymbol(cls.name, cls.extends ? `extends ${cls.extends}` : "", cls.kind === "interface" ? vscode.SymbolKind.Interface : vscode.SymbolKind.Class, range(cls.start, cls.bodyEnd + 1), range(cls.nameOffset, cls.nameOffset + cls.name.length));
      for (const property of cls.properties) {
        const at = document.getText().indexOf(property.name, property.offset);
        symbol.children.push(new vscode.DocumentSymbol(property.name, property.type, vscode.SymbolKind.Field, range(property.offset, at + property.name.length), range(at, at + property.name.length)));
      }
      for (const method of cls.methods) {
        const end = method.bodyEnd > 0 ? method.bodyEnd + 1 : method.nameOffset + method.name.length;
        const kind = method.name === "__construct" ? vscode.SymbolKind.Constructor : vscode.SymbolKind.Method;
        symbol.children.push(new vscode.DocumentSymbol(method.name, `(${method.params.map(parameterText).join(", ")}): ${method.returns}`, kind, range(method.start, end), range(method.nameOffset, method.nameOffset + method.name.length)));
      }
      symbols.push(symbol);
    }
    return symbols.sort((a, b) => a.range.start.compareTo(b.range.start));
  },
};

// ---------------------------------------------------------------------------
// Compile errors: `qiq check` runs on a document's text shortly after it
// changes, and the error it reports is shown in the editor and in Problems.

const CHECK_DELAY = 300;

/** The range to underline: what the message quotes, when it's on the
 * error's line (see diagnostics.quotedOnLine), else the word at the error's
 * position, or one character there. The whole first line when the error
 * has no position. */
function errorRange(document, error) {
  if (error.line === null) return document.lineAt(0).range;
  const line = Math.min(error.line - 1, document.lineCount - 1);
  const column = Math.max(0, error.column - 1);
  const quoted = diagnostics.quotedOnLine(document.lineAt(line).text, column, error.message);
  if (quoted) return new vscode.Range(new vscode.Position(line, quoted.start), new vscode.Position(line, quoted.end));
  const start = new vscode.Position(line, column);
  const word = document.getWordRangeAtPosition(start);
  if (word && word.start.compareTo(start) === 0) return word;
  return new vscode.Range(start, new vscode.Position(line, start.character + 1));
}

class Checker {
  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection(LANGUAGE);
    this.timers = new Map(); // document URI -> pending check
    this.runs = new Map(); // document URI -> number of the latest check
    this.elsewhere = new Map(); // document URI -> URI of an imported file its error was put on
    this.warned = false;
  }

  settings() {
    const config = vscode.workspace.getConfiguration(LANGUAGE);
    return { enabled: config.get("diagnostics.enabled", true), qiq: config.get("path", "qiq") || "qiq" };
  }

  schedule(document, delay = CHECK_DELAY) {
    if (document.languageId !== LANGUAGE || document.uri.scheme !== "file") return;
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(key, setTimeout(() => this.check(document), delay));
  }

  async check(document) {
    const key = document.uri.toString();
    this.timers.delete(key);
    const { enabled, qiq } = this.settings();
    if (!enabled) return this.clear(document.uri);
    const run = (this.runs.get(key) || 0) + 1;
    this.runs.set(key, run);
    let error;
    try {
      error = await diagnostics.check(qiq, document.uri.fsPath, document.getText());
    } catch (failure) {
      if (!this.warned) {
        this.warned = true;
        const reason = failure.code === "ENOENT" ? `'${qiq}' was not found` : failure.message;
        vscode.window.showWarningMessage(`qiq: can't check for errors: ${reason}. Set "qiq.path" to the qiq executable.`);
      }
      return;
    }
    // A later check has started, or the document was closed.
    if (this.runs.get(key) !== run || document.isClosed) return;
    this.clear(document.uri);
    if (!error) return;
    if (path.resolve(error.file) === path.resolve(document.uri.fsPath)) {
      this.collection.set(document.uri, [this.diagnostic(errorRange(document, error), error.message)]);
      return;
    }
    // The error is in a file this one imports: show it there, and say so here.
    const other = vscode.Uri.file(error.file);
    const where = error.line === null ? error.file : `${error.file}:${error.line}:${error.column}`;
    this.collection.set(document.uri, [this.diagnostic(document.lineAt(0).range, `in ${where}: ${error.message}`)]);
    if (fs.existsSync(error.file)) {
      const line = Math.max(0, (error.line || 1) - 1);
      const column = Math.max(0, (error.column || 1) - 1);
      const range = new vscode.Range(new vscode.Position(line, column), new vscode.Position(line, error.line === null ? 1000 : column + 1));
      this.collection.set(other, [this.diagnostic(range, error.message)]);
      this.elsewhere.set(key, other);
    }
  }

  diagnostic(range, message) {
    const diagnostic = new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error);
    diagnostic.source = LANGUAGE;
    return diagnostic;
  }

  clear(uri) {
    const key = uri.toString();
    this.collection.delete(uri);
    const other = this.elsewhere.get(key);
    if (other) {
      this.collection.delete(other);
      this.elsewhere.delete(key);
    }
  }

  close(document) {
    const key = document.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.runs.delete(key);
    this.clear(document.uri);
  }

  dispose() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.collection.dispose();
  }
}

function activate(extension) {
  const checker = new Checker();
  const selector = { language: LANGUAGE };
  extension.subscriptions.push(
    vscode.languages.registerCompletionItemProvider(selector, completionProvider, ">", ":", '"', "/"),
    vscode.languages.registerHoverProvider(selector, hoverProvider),
    vscode.languages.registerSignatureHelpProvider(selector, signatureProvider, { triggerCharacters: ["(", ","], retriggerCharacters: [" "] }),
    vscode.languages.registerDefinitionProvider(selector, definitionProvider),
    vscode.languages.registerDocumentSymbolProvider(selector, symbolProvider),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (path.basename(document.uri.fsPath) === "qiq.mod") project.forget();
      contexts.clear();
      // Saving one file can fix or break the files that import it.
      for (const open of vscode.workspace.textDocuments) checker.schedule(open, 0);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      contexts.delete(document.uri.toString());
      checker.close(document);
    }),
    checker,
    vscode.workspace.onDidOpenTextDocument((document) => checker.schedule(document, 0)),
    vscode.workspace.onDidChangeTextDocument((event) => checker.schedule(event.document)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration(LANGUAGE)) return;
      checker.warned = false;
      for (const open of vscode.workspace.textDocuments) checker.schedule(open, 0);
    })
  );
  for (const open of vscode.workspace.textDocuments) checker.schedule(open, 0);
}

function deactivate() {}

module.exports = { activate, deactivate, importEdit };
