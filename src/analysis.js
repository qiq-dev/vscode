// Reading qiq source well enough for completion, hovers, and parameter
// hints: imports, functions, classes and their members, the variables in
// scope at a position, and the type of an expression such as
// `this->items[0]->name`. It works on unfinished code, so it uses patterns
// and bracket matching rather than the compiler's parser. Nothing here
// depends on VS Code, so it can be tested on its own (see test/).
"use strict";

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";
const PRIMITIVES = ["int", "double", "bool", "byte", "string", "char", "void"];
const KEYWORDS = [
  "if", "else", "foreach", "while", "switch", "case", "default", "break", "continue", "return",
  "try", "catch", "finally", "throw", "as", "new", "function", "fn", "class", "interface", "extends",
  "implements", "abstract", "final", "static", "public", "private", "protected", "import", "from",
  "true", "false", "null", "this", "self", "parent", "print", "println", "map", "instanceof", "const", "readonly",
];

/** Whether an f-string starts at `i`: an `f` that begins a word, then `"`. */
function isFString(text, i) {
  return text[i] === "f" && text[i + 1] === '"' && !(i > 0 && /[A-Za-z0-9_$]/.test(text[i - 1]));
}

/** The f-string starting at `i` (its `f`), read as the compiler reads it:
 * `end` is just after its closing quote (or where the line or text ends
 * without one), and `holes` the expressions inside `{}` ({start, end},
 * without the braces or a `:spec`). `{{` and `}}` are braces in the text. */
function fstringSpans(text, i) {
  const n = text.length;
  const holes = [];
  let at = i + 2;
  while (at < n && text[at] !== '"' && text[at] !== "\n") {
    const c = text[at];
    if (c === "\\") {
      at += 2;
    } else if ((c === "{" && text[at + 1] === "{") || (c === "}" && text[at + 1] === "}")) {
      at += 2;
    } else if (c === "{") {
      const start = at + 1;
      let depth = 0;
      let end = -1;
      let j = start;
      while (j < n && text[j] !== "\n") {
        const d = text[j];
        if (d === '"' || d === "'" || d === "`") {
          // A string or char inside the expression.
          j++;
          while (j < n && text[j] !== d && text[j] !== "\n") j += text[j] === "\\" && d !== "`" ? 2 : 1;
          j++;
          continue;
        }
        if (d === "(" || d === "[" || d === "{") depth++;
        else if ((d === ")" || d === "]") && depth > 0) depth--;
        else if (d === "}" && depth > 0) depth--;
        else if (d === "}" || (d === ":" && depth === 0 && text[j + 1] !== ":" && text[j - 1] !== ":")) {
          end = j;
          break;
        }
        j++;
      }
      if (end < 0) {
        // Not closed (yet): the expression runs to the end of the line.
        holes.push({ start, end: j });
        return { end: j, holes };
      }
      holes.push({ start, end });
      // Past the closing brace, and any spec before it.
      while (j < n && text[j] !== "}" && text[j] !== "\n") j++;
      at = j + 1;
    } else {
      at++;
    }
  }
  return { end: at < n && text[at] === '"' ? at + 1 : at, holes };
}

/** The text with comments and the contents of string and char literals
 * replaced by spaces (same length, same line breaks), so patterns and
 * bracket matching don't see them. Quotes are kept. */
function mask(text) {
  const out = text.split("");
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") out[i++] = " ";
    } else if (c === "/" && text[i + 1] === "*") {
      // A block comment: blanked up to and including the first */, keeping
      // line breaks. One that isn't closed runs to the end of the text.
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      for (; i < stop; i++) if (text[i] !== "\n") out[i] = " ";
    } else if (isFString(text, i)) {
      // An f-string: the text and braces blanked, the expressions kept
      // (themselves masked), so completion and hovers work inside them.
      const { end, holes } = fstringSpans(text, i);
      for (let at = i + 2; at < end - 1; at++) if (text[at] !== "\n") out[at] = " ";
      for (const hole of holes) {
        const inner = mask(text.slice(hole.start, hole.end));
        for (let at = 0; at < inner.length; at++) out[hole.start + at] = inner[at];
      }
      i = end;
    } else if (c === "`") {
      // A raw string: blanked up to the closing backtick, keeping line
      // breaks, with no escapes. The backticks are kept.
      i++;
      while (i < n && text[i] !== "`") {
        if (text[i] !== "\n") out[i] = " ";
        i++;
      }
      i++;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < n && text[i] !== c && text[i] !== "\n") {
        if (text[i] === "\\" && i + 1 < n && text[i + 1] !== "\n") {
          out[i++] = " ";
        }
        out[i++] = " ";
      }
      if (i < n && text[i] === c) i++;
    } else {
      i++;
    }
  }
  return out.join("");
}

/** What the position is inside: "comment", "string" (with the text so far
 * and where the string starts), "char", or "code". Quoted strings don't
 * span lines; block comments and raw strings can, so the scan starts at the
 * top of the text. */
function lexicalContext(text, offset) {
  let i = 0;
  while (i < offset) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      if (end < 0 || end >= offset) return { kind: "comment" };
      i = end + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0 || end + 2 > offset) return { kind: "comment" };
      i = end + 2;
      continue;
    }
    if (isFString(text, i)) {
      const { end, holes } = fstringSpans(text, i);
      if (end > offset || (end === offset && text[end - 1] !== '"')) {
        // Inside it: in an expression, as code there; otherwise in its text.
        const hole = holes.find((h) => h.start <= offset && offset <= h.end);
        if (hole) return lexicalContext(text.slice(hole.start, offset), offset - hole.start);
        return { kind: "string", start: i + 1, value: text.slice(i + 2, offset) };
      }
      i = end;
      continue;
    }
    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end < 0 || end >= offset) return { kind: "string", start: i, value: text.slice(i + 1, offset) };
      i = end + 1;
      continue;
    }
    if (c === '"' || c === "'") {
      const start = i;
      i++;
      while (i < offset && text[i] !== c && text[i] !== "\n") i += text[i] === "\\" ? 2 : 1;
      if (i >= offset) return { kind: c === '"' ? "string" : "char", start, value: text.slice(start + 1, offset) };
    }
    i++;
  }
  return { kind: "code" };
}

/** The index of the bracket that closes the one at `open`, in masked text,
 * or the text's length if it isn't closed. */
function matching(masked, open) {
  const pairs = { "(": ")", "[": "]", "{": "}" };
  const close = pairs[masked[open]];
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === masked[open]) depth++;
    else if (masked[i] === close && --depth === 0) return i;
  }
  return masked.length;
}

/** Splits `text` at commas outside brackets. */
function splitTopLevel(text, separator = ",") {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const c of text) {
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth--;
    if (c === separator && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += c;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** `int count = 0` -> {type: "int", name: "count", default: "0"}. A
 * constructor parameter written with `public`, `protected`, `private`, or
 * `readonly` is also a property: `promoted` is its visibility. */
function parseParameter(text) {
  let [declaration, ...rest] = splitTopLevel(text, "=");
  declaration = declaration.trim();
  if (declaration === "...") return { type: "...", name: "values", default: null, variadic: true };
  const modifiers = declaration.match(/^((?:(?:public|protected|private|readonly)\s+)*)/)[1];
  declaration = declaration.slice(modifiers.length);
  const match = declaration.match(new RegExp(`^(.*\\S)\\s+(${IDENT})$`, "s"));
  if (!match) return null;
  const parameter = {
    type: normalizeType(match[1]),
    name: match[2],
    default: rest.length ? rest.join("=").trim() : null,
  };
  if (modifiers) {
    parameter.promoted = (modifiers.match(/\b(public|protected|private)\b/) || [, "public"])[1];
    parameter.readonly = /\breadonly\b/.test(modifiers);
  }
  return parameter;
}

function normalizeType(type) {
  return type.replace(/\s+/g, " ").replace(/\s*\[\s*\]/g, "[]").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
}

/** The comment just above `offset`'s line: its // lines, or a block
 * comment that ends there, joined without the comment markers. */
function docCommentAbove(text, offset) {
  const lines = text.slice(0, text.lastIndexOf("\n", offset - 1) + 1).split("\n");
  lines.pop();
  const doc = [];
  if (lines.length && lines[lines.length - 1].trim().endsWith("*/")) {
    while (lines.length) {
      const line = lines.pop().trim();
      const opens = line.startsWith("/*");
      const body = line
        .replace(/^\/\*+/, "")
        .replace(/\*+\/$/, "")
        .replace(/^\*(?!\/)\s?/, "")
        .trim();
      doc.unshift(body);
      if (opens) return doc.join("\n").trim();
    }
    return "";
  }
  while (lines.length) {
    const line = lines[lines.length - 1].trim();
    if (!line.startsWith("//")) break;
    doc.unshift(line.replace(/^\/\/\s?/, ""));
    lines.pop();
  }
  return doc.join("\n").trim();
}

/** A function header starting at `start` (at "function"): its name,
 * parameters, return type, and body range. */
function parseFunctionAt(text, masked, start) {
  const header = new RegExp(`function\\s+(${IDENT})\\s*\\(`, "y");
  header.lastIndex = start;
  const match = header.exec(masked);
  if (!match) return null;
  const open = header.lastIndex - 1;
  const close = matching(masked, open);
  const params = splitTopLevel(masked.slice(open + 1, close))
    .map((part, index, all) => {
      // Defaults are read from the real text (they may be strings).
      const offsetInList = all.slice(0, index).reduce((sum, p) => sum + p.length + 1, 0);
      return parseParameter(text.slice(open + 1 + offsetInList, open + 1 + offsetInList + part.length));
    })
    .filter(Boolean);
  let i = close + 1;
  let returns = "void";
  const after = masked.slice(i);
  const colon = after.match(/^\s*:\s*/);
  let bodyStart = -1;
  let bodyEnd = -1;
  if (colon) {
    i += colon[0].length;
    // The return type runs to the body's "{" or the ";" of an abstract
    // method; function types contain their own parentheses.
    let j = i;
    let depth = 0;
    while (j < masked.length) {
      const c = masked[j];
      if (c === "(" || c === "[") depth++;
      else if (c === ")" || c === "]") depth--;
      else if ((c === "{" || c === ";") && depth === 0) break;
      j++;
    }
    returns = normalizeType(masked.slice(i, j));
    i = j;
  }
  const rest = masked.slice(i).match(/^\s*([{;])/);
  if (rest && rest[1] === "{") {
    bodyStart = i + rest[0].length - 1;
    bodyEnd = matching(masked, bodyStart);
  }
  return {
    name: match[1],
    params,
    returns,
    start,
    nameOffset: start + match[0].indexOf(match[1], 8),
    bodyStart,
    bodyEnd,
    doc: docCommentAbove(text, start),
  };
}

/** Brace depth before each offset of masked text. */
function depths(masked) {
  const result = new Int32Array(masked.length + 1);
  let depth = 0;
  for (let i = 0; i < masked.length; i++) {
    result[i] = depth;
    if (masked[i] === "{") depth++;
    else if (masked[i] === "}") depth = Math.max(0, depth - 1);
  }
  result[masked.length] = depth;
  return result;
}

/** Reads a whole document: its imports, top-level functions, and classes
 * and interfaces with their members. */
function parseDocument(text) {
  const masked = mask(text);
  const depth = depths(masked);
  const imports = [];
  const importPattern = /^[ \t]*import\s+([^;"]*?)\s+from\s*"/gm;
  let match;
  while ((match = importPattern.exec(masked))) {
    const pathStart = importPattern.lastIndex;
    const pathEnd = text.indexOf('"', pathStart);
    const lineEnd = text.indexOf("\n", match.index);
    const names = match[1].split(",").map((part) => part.trim()).filter(Boolean).map((part) => {
      const [name, alias] = part.split(/\s+as\s+/);
      return { name: name.trim(), alias: (alias || name).trim() };
    });
    imports.push({
      names,
      path: pathEnd >= 0 && (lineEnd < 0 || pathEnd < lineEnd) ? text.slice(pathStart, pathEnd) : text.slice(pathStart, lineEnd < 0 ? undefined : lineEnd),
      start: match.index,
      end: lineEnd < 0 ? text.length : lineEnd,
    });
  }

  const functions = [];
  const functionPattern = new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`, "g");
  while ((match = functionPattern.exec(masked))) {
    if (depth[match.index] !== 0) continue;
    const parsed = parseFunctionAt(text, masked, match.index);
    if (!parsed) continue;
    const before = masked.slice(masked.lastIndexOf("\n", match.index - 1) + 1, match.index);
    parsed.private = /\bprivate\b/.test(before);
    parsed.extern = /\bextern\b/.test(before);
    functions.push(parsed);
    if (parsed.bodyEnd > 0) functionPattern.lastIndex = parsed.bodyEnd;
  }

  const classes = [];
  const classPattern = new RegExp(
    `\\b((?:(?:abstract|final|private)\\s+)*)(class|interface)\\s+(${IDENT})(?:\\s+extends\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*))?(?:\\s+implements\\s+(${IDENT}(?:\\s*,\\s*${IDENT})*))?\\s*\\{`,
    "g"
  );
  while ((match = classPattern.exec(masked))) {
    if (depth[match.index] !== 0) continue;
    const bodyStart = classPattern.lastIndex - 1;
    const bodyEnd = matching(masked, bodyStart);
    const list = (names) => (names ? names.split(",").map((name) => name.trim()) : []);
    const isInterface = match[2] === "interface";
    const parents = list(match[4]);
    const cls = {
      name: match[3],
      kind: match[2],
      abstract: /\babstract\b/.test(match[1]),
      final: /\bfinal\b/.test(match[1]),
      private: /\bprivate\b/.test(match[1]),
      extends: isInterface ? null : parents[0] || null,
      interfaces: isInterface ? parents : list(match[5]),
      start: match.index,
      nameOffset: match.index + match[0].indexOf(match[3], match[1].length + match[2].length),
      bodyStart,
      bodyEnd,
      doc: docCommentAbove(text, match.index),
      properties: [],
      methods: [],
    };
    parseMembers(text, masked, cls);
    classes.push(cls);
    classPattern.lastIndex = bodyEnd;
  }
  return { imports, functions, classes, masked, depth };
}

/** Fills in a class's properties and methods: the statements directly in
 * its body, each ending at ";" or at a method's body. */
function parseMembers(text, masked, cls) {
  let i = cls.bodyStart + 1;
  let statementStart = i;
  while (i < cls.bodyEnd) {
    const c = masked[i];
    if (c === ";" || c === "{") {
      const statement = masked.slice(statementStart, i);
      const leading = statement.length - statement.trimStart().length;
      const start = statementStart + leading;
      const modifiers = statement.trim().match(/^((?:(?:public|private|protected|static|final|abstract|readonly)\s+)*)/)[1];
      const rest = statement.trim().slice(modifiers.length);
      const visibility = (modifiers.match(/\b(public|private|protected)\b/) || [, "public"])[1];
      const isStatic = /\bstatic\b/.test(modifiers);
      if (/^function\s/.test(rest)) {
        const method = parseFunctionAt(text, masked, start + modifiers.length);
        if (method) {
          method.visibility = visibility;
          method.static = isStatic;
          method.abstract = /\babstract\b/.test(modifiers) || method.bodyStart < 0;
          method.doc = docCommentAbove(text, start);
          cls.methods.push(method);
          // Promoted constructor parameters are properties too.
          if (method.name === "__construct") {
            for (const param of method.params) {
              if (!param.promoted) continue;
              cls.properties.push({
                name: param.name,
                type: param.type,
                visibility: param.promoted,
                static: false,
                readonly: param.readonly,
                offset: method.start,
                doc: "",
              });
            }
          }
          i = method.bodyEnd > 0 ? method.bodyEnd : i;
        }
      } else if (c === ";" && /^const\s/.test(rest)) {
        // `const [type] NAME = value;`: a constant, read with Class::NAME.
        const constant = rest.match(new RegExp(`^const\\s+(?:(.*?)\\s+)?(${IDENT})\\s*=\\s*([\\s\\S]*)$`));
        if (constant) {
          const value = text.slice(start + modifiers.length, i).replace(/^[\s\S]*?=\s*/, "").trim();
          cls.properties.push({
            name: constant[2],
            type: constant[1] ? normalizeType(constant[1]) : literalType(value) || "int",
            visibility,
            static: true,
            constant: true,
            value,
            offset: start,
            doc: docCommentAbove(text, start),
          });
        }
      } else if (c === ";" && rest.trim()) {
        const property = parseParameter(text.slice(start + modifiers.length, i));
        if (property) {
          cls.properties.push({
            name: property.name,
            type: property.type,
            visibility,
            static: isStatic,
            readonly: /\breadonly\b/.test(modifiers),
            offset: start,
            doc: docCommentAbove(text, start),
          });
        }
      } else if (c === "{") {
        i = matching(masked, i);
      }
      statementStart = i + 1;
    }
    i++;
  }
}

/** The functions (named, anonymous, and arrow) whose bodies contain `offset`,
 * innermost last. */
function enclosingFunctions(text, masked, offset) {
  const result = [];
  const pattern = /\b(function|fn)\b\s*(\w*)\s*\(/g;
  let match;
  while ((match = pattern.exec(masked))) {
    if (match.index >= offset) break;
    const open = pattern.lastIndex - 1;
    const close = matching(masked, open);
    const params = splitTopLevel(masked.slice(open + 1, close)).map(parseParameter).filter(Boolean);
    let bodyStart;
    let bodyEnd;
    if (match[1] === "fn") {
      // fn(...) => expression: the expression runs to the end of the
      // enclosing call or statement.
      const arrow = masked.indexOf("=>", close);
      if (arrow < 0) continue;
      bodyStart = arrow + 2;
      let depth = 0;
      bodyEnd = bodyStart;
      while (bodyEnd < masked.length) {
        const c = masked[bodyEnd];
        if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) {
          if (depth === 0) break;
          depth--;
        } else if ((c === "," || c === ";") && depth === 0) break;
        bodyEnd++;
      }
    } else {
      bodyStart = masked.indexOf("{", close);
      const semicolon = masked.indexOf(";", close);
      if (bodyStart < 0 || (semicolon >= 0 && semicolon < bodyStart)) continue;
      bodyEnd = matching(masked, bodyStart);
    }
    if (bodyStart < offset && offset <= bodyEnd) {
      result.push({ named: match[1] === "function" && match[2] !== "", name: match[2], params, bodyStart, bodyEnd });
    }
  }
  return result;
}

const TYPE_PATTERN = `(?:int|double|bool|byte|string|char|map\\s*\\[[^;{}=]*?\\]|[A-Z][A-Za-z0-9_]*)(?:\\s*\\[\\s*\\])*`;

/** The variables visible at `offset`, each {name, type}, with `type` null
 * when it can't be told. `doc` is from parseDocument(text). Later
 * declarations of the same name win. */
function variablesAt(text, doc, offset, resolver) {
  const masked = doc.masked;
  const variables = new Map();
  const add = (name, type) => {
    if (!variables.has(name) || (type && !variables.get(name).type)) variables.set(name, { name, type: type || null });
  };
  const functions = enclosingFunctions(text, masked, offset);
  // Variables of the top level aren't visible inside named functions;
  // anonymous functions see their enclosing function's variables.
  let scopeStart = 0;
  let outermostNamed = -1;
  functions.forEach((fn, index) => {
    if (fn.named && outermostNamed < 0) outermostNamed = index;
  });
  const visible = outermostNamed >= 0 ? functions.slice(outermostNamed) : functions;
  if (outermostNamed >= 0) scopeStart = functions[outermostNamed].bodyStart;
  for (const fn of visible) for (const param of fn.params) add(param.name, param.type);

  const cls = doc.classes.find((c) => c.bodyStart < offset && offset < c.bodyEnd);
  if (cls && outermostNamed >= 0) add("this", cls.name);

  // Skip the bodies of named functions and classes that don't contain the
  // position: their variables are their own.
  const skipped = [];
  if (outermostNamed < 0) {
    for (const fn of doc.functions) if (fn.bodyStart >= 0 && !(fn.bodyStart < offset && offset <= fn.bodyEnd)) skipped.push([fn.bodyStart, fn.bodyEnd]);
    for (const c of doc.classes) if (!(c.bodyStart < offset && offset <= c.bodyEnd)) skipped.push([c.bodyStart, c.bodyEnd]);
  }
  let region = masked.slice(scopeStart, offset);
  for (const [start, end] of skipped) {
    if (end < scopeStart || start > offset) continue;
    const from = Math.max(start, scopeStart) - scopeStart;
    const to = Math.min(end, offset) - scopeStart;
    region = region.slice(0, from) + " ".repeat(Math.max(0, to - from)) + region.slice(to);
  }

  // Typed declarations: `int count = 0;`, `string[] names;`, `Node head = null;`
  const declared = new RegExp(`(?<![\\w>:.$])(${TYPE_PATTERN})\\s+(${IDENT})\\s*(?=[=;])`, "g");
  let match;
  while ((match = declared.exec(region))) {
    if (KEYWORDS.includes(match[2])) continue;
    // In `function(int): bool f = ...`, "bool f" is a function type's return type.
    if (/\)\s*:\s*$/.test(region.slice(Math.max(0, match.index - 40), match.index))) continue;
    add(match[2], normalizeType(match[1]));
  }
  // Function-typed declarations: `function(int): int f = ...`
  const functionTyped = new RegExp(`(?:^|[;{}])\\s*(function\\s*\\(.*?\\)\\s*:\\s*[^=;{]+?)\\s+(${IDENT})\\s*=`, "gs");
  while ((match = functionTyped.exec(region))) add(match[2], normalizeType(match[1]));
  // catch (Type e)
  const caught = new RegExp(`\\bcatch\\s*\\(\\s*(${IDENT})\\s+(${IDENT})\\s*\\)`, "g");
  while ((match = caught.exec(region))) add(match[2], match[1]);
  // if (shape instanceof Circle circle): `circle` is a Circle.
  const bound = new RegExp(`\\binstanceof\\s+(${IDENT})\\s+(${IDENT})\\b`, "g");
  while ((match = bound.exec(region))) if (!KEYWORDS.includes(match[2])) add(match[2], match[1]);
  // foreach (items as value) and foreach (items as key => value)
  const loop = new RegExp(`\\bforeach\\s*\\(\\s*(.+?)\\s+as\\s+(?:(${IDENT})\\s*=>\\s*)?(${IDENT})\\s*\\)`, "g");
  while ((match = loop.exec(region))) {
    const collection = resolver ? resolver.typeOfText(text.slice(scopeStart + match.index, scopeStart + match.index + match[0].length).match(/\(\s*(.+?)\s+as\s/s)[1], offset) : null;
    const [keyType, valueType] = elementTypes(collection, match[1]);
    if (match[2]) add(match[2], keyType);
    add(match[3], valueType);
  }
  // Inferred declarations: `name = value;` the first time a name is assigned.
  const assigned = new RegExp(`(?:^|[;{}])\\s*(${IDENT})\\s*=(?![=>])\\s*([^;]*)`, "g");
  while ((match = assigned.exec(region))) {
    if (KEYWORDS.includes(match[1]) || variables.has(match[1])) continue;
    const valueOffset = scopeStart + match.index + match[0].length - match[2].length;
    add(match[1], resolver ? resolver.typeOfText(text.slice(valueOffset, valueOffset + match[2].length), offset) : literalType(match[2]));
  }
  return [...variables.values()];
}

/** The key and value types of a foreach over a value of type `type`. */
function elementTypes(type, collectionText) {
  if (!type) {
    // `range(...)` counts with ints.
    if (/^\s*range\s*\(/.test(collectionText || "")) return ["int", "int"];
    return [null, null];
  }
  if (type.endsWith("[]")) return ["int", type.slice(0, -2)];
  const map = type.match(/^map\s*\[(.*)\]$/);
  if (map) {
    const [key, value] = splitTopLevel(map[1]);
    return [normalizeType(key || ""), normalizeType(value || "")];
  }
  if (type === "string") return ["int", "char"];
  return [null, null];
}

function literalType(text) {
  const value = text.trim();
  if (/^"/.test(value)) return "string";
  if (/^'/.test(value)) return "char";
  if (/^-?\d+\.\d+/.test(value)) return "double";
  if (/^-?\d+\b/.test(value)) return "int";
  if (/^(true|false)\b/.test(value)) return "bool";
  const created = value.match(new RegExp(`^new\\s+(${IDENT})`));
  if (created) return created[1];
  return null;
}

/** The expression that ends at `end` (just before "->", "::", or "("), as
 * text: walks back over names, calls, indexes, "->", "::", and "new". */
function expressionBefore(masked, end) {
  let i = end;
  const skipSpace = () => {
    while (i > 0 && /\s/.test(masked[i - 1])) i--;
  };
  skipSpace();
  for (;;) {
    // Calls and indexes: skip back over balanced brackets.
    while (i > 0 && (masked[i - 1] === ")" || masked[i - 1] === "]")) {
      const close = masked[i - 1];
      const open = close === ")" ? "(" : "[";
      let depth = 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        if (masked[j] === close) depth++;
        else if (masked[j] === open && --depth === 0) break;
      }
      if (j < 0) return null;
      i = j;
      skipSpace();
    }
    let start = i;
    while (start > 0 && /[A-Za-z0-9_]/.test(masked[start - 1])) start--;
    if (start === i) {
      // Only a literal string can be called on by nothing; give up.
      if (masked[i - 1] === '"') {
        const open = masked.lastIndexOf('"', i - 2);
        return open >= 0 ? { start: open, end } : null;
      }
      return null;
    }
    i = start;
    const save = i;
    skipSpace();
    if (masked.slice(i - 3, i) === "?->") {
      i -= 3;
      skipSpace();
      continue;
    }
    if (masked.slice(i - 2, i) === "->" || masked.slice(i - 2, i) === "::") {
      i -= 2;
      skipSpace();
      continue;
    }
    if (/\bnew\s*$/.test(masked.slice(Math.max(0, i - 8), i))) {
      i = masked.lastIndexOf("new", i);
      return { start: i, end };
    }
    return { start: save, end };
  }
}

/** Splits an expression such as `new A(1)->b->c(2)[0]` into steps:
 * {kind: "new"|"name"|"call"|"member"|"method"|"static"|"staticCall"|"index", name}. */
function steps(masked, start, end) {
  const result = [];
  let i = start;
  const skipSpace = () => {
    while (i < end && /\s/.test(masked[i])) i++;
  };
  const readName = () => {
    const match = new RegExp(IDENT, "y");
    match.lastIndex = i;
    const found = match.exec(masked);
    if (!found || match.lastIndex > end) return null;
    i = match.lastIndex;
    return found[0];
  };
  const skipBrackets = () => {
    const close = matching(masked, i);
    i = close + 1;
  };
  skipSpace();
  if (masked[i] === '"') {
    result.push({ kind: "literal", type: "string" });
    i = masked.indexOf('"', i + 1) + 1;
  } else if (masked.startsWith("new", i) && /\s/.test(masked[i + 3] || "")) {
    i += 3;
    skipSpace();
    const name = readName();
    if (!name) return null;
    skipSpace();
    if (i < end && masked[i] === "(") skipBrackets();
    result.push({ kind: "new", name });
  } else {
    const name = readName();
    if (!name) return null;
    skipSpace();
    if (i < end && masked[i] === "(") {
      skipBrackets();
      result.push({ kind: "call", name });
    } else {
      result.push({ kind: "name", name });
    }
  }
  for (;;) {
    skipSpace();
    if (i >= end) break;
    if (masked[i] === "[") {
      skipBrackets();
      result.push({ kind: "index" });
    } else if (masked.startsWith("->", i) || masked.startsWith("?->", i) || masked.startsWith("::", i)) {
      // `?->` reads a member like `->`, giving null for a null object.
      const staticAccess = masked[i] === ":";
      i += masked[i] === "?" ? 3 : 2;
      skipSpace();
      const name = readName();
      if (!name) return null;
      skipSpace();
      if (i < end && masked[i] === "(") {
        skipBrackets();
        result.push({ kind: staticAccess ? "staticCall" : "method", name });
      } else {
        result.push({ kind: staticAccess ? "staticMember" : "member", name });
      }
    } else if (masked[i] === "(") {
      // Calling a function value: f(1)(2).
      skipBrackets();
      result.push({ kind: "invoke" });
    } else {
      return null;
    }
  }
  return result;
}

/** The return type of a function type: "function(int): string" -> "string". */
function functionReturnType(type) {
  if (!type || !type.startsWith("function")) return null;
  const open = type.indexOf("(");
  let depth = 0;
  for (let i = open; i < type.length; i++) {
    if (type[i] === "(") depth++;
    else if (type[i] === ")" && --depth === 0) {
      const rest = type.slice(i + 1).match(/^\s*:\s*(.*)$/);
      return rest ? rest[1].trim() : null;
    }
  }
  return null;
}

/** What to complete at `offset`:
 *   {kind: "comment"} / {kind: "string"}: nothing
 *   {kind: "importPath", prefix, start}: inside `from "..."`
 *   {kind: "importName", path, prefix}: the names of `import ... from "path"`
 *   {kind: "member", expression: {start, end}, prefix}: after `->`
 *   {kind: "static", expression, prefix}: after `Class::`
 *   {kind: "new", prefix}: after `new `
 *   {kind: "type", prefix}: after `extends`, `implements`, `catch (`
 *   {kind: "general", prefix}: anything else
 * `prefix` is the part of the word typed so far. */
function completionContext(text, offset) {
  const lexical = lexicalContext(text, offset);
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const line = text.slice(lineStart, offset);
  if (lexical.kind === "comment") return { kind: "comment" };
  if (lexical.kind === "string" || lexical.kind === "char") {
    if (lexical.kind === "string" && /^\s*import\b.*\bfrom\s*"[^"]*$/.test(line)) {
      return { kind: "importPath", prefix: lexical.value, start: lexical.start + 1 };
    }
    return { kind: "string" };
  }
  const masked = mask(text);
  const word = line.match(/[A-Za-z_][A-Za-z0-9_]*$/);
  const prefix = word ? word[0] : "";
  const before = offset - prefix.length;
  const lineBefore = text.slice(lineStart, before);
  const importLine = text.slice(lineStart, text.indexOf("\n", offset) < 0 ? text.length : text.indexOf("\n", offset));
  if (/^\s*import\s+[^"]*$/.test(lineBefore) && !/\bfrom\s*$/.test(lineBefore)) {
    const path = importLine.match(/\bfrom\s*"([^"]*)"/);
    return { kind: "importName", path: path ? path[1] : null, prefix };
  }
  if (/\bfrom\s*$/.test(lineBefore) && /^\s*import\b/.test(lineBefore)) return { kind: "importFrom", prefix };
  const tail = masked.slice(Math.max(0, before - 2), before);
  const spaced = masked.slice(0, before).replace(/\s+$/, "");
  if (spaced.endsWith("->")) {
    // After `?->` too, which reads a member of an object that may be null.
    const expression = expressionBefore(masked, spaced.length - (spaced.endsWith("?->") ? 3 : 2));
    return expression ? { kind: "member", expression, prefix } : { kind: "general", prefix };
  }
  if (spaced.endsWith("::") || tail === "::") {
    const expression = expressionBefore(masked, spaced.length - 2);
    return expression ? { kind: "static", expression, prefix } : { kind: "general", prefix };
  }
  if (/\bnew\s+$/.test(lineBefore)) return { kind: "new", prefix };
  if (/\b(extends|implements)\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*,\s*)*$/.test(lineBefore) || /\bcatch\s*\(\s*$/.test(lineBefore)) {
    return { kind: "type", prefix };
  }
  return { kind: "general", prefix };
}

/** The call around `offset`, for parameter hints: the callee expression,
 * which argument the position is in, and the names given to arguments
 * before it (`timeout: 5`). Null when not inside a call's parentheses. */
function callAt(text, offset) {
  const masked = mask(text);
  let depth = 0;
  let argument = 0;
  let named = null;
  for (let i = offset - 1; i >= 0; i--) {
    const c = masked[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "[" || c === "{") {
      if (depth === 0) return null;
      depth--;
    } else if (c === "(") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const argumentText = masked.slice(i + 1, offset);
      const current = splitTopLevel(argumentText + " ").pop() || "";
      const name = current.match(new RegExp(`^\\s*(${IDENT})\\s*:(?!:)`));
      named = name ? name[1] : null;
      let j = i;
      while (j > 0 && /\s/.test(masked[j - 1])) j--;
      const isNew = /\bnew\s+[A-Za-z_][A-Za-z0-9_]*$/.test(masked.slice(Math.max(0, j - 80), j));
      const expression = expressionBefore(masked, j);
      if (!expression) return null;
      const calleeSteps = steps(masked, expression.start, j);
      // `if (`, `while (`, ...: not calls.
      if (calleeSteps && calleeSteps.length === 1 && calleeSteps[0].kind === "name" && KEYWORDS.includes(calleeSteps[0].name) && calleeSteps[0].name !== "print" && calleeSteps[0].name !== "println") return null;
      return { expression, argument, named, isNew, open: i };
    } else if (c === "," && depth === 0) {
      argument++;
    } else if (c === ";" && depth === 0) {
      return null;
    }
  }
  return null;
}

module.exports = {
  fstringSpans,
  KEYWORDS,
  PRIMITIVES,
  mask,
  lexicalContext,
  matching,
  splitTopLevel,
  parseParameter,
  parseDocument,
  enclosingFunctions,
  variablesAt,
  elementTypes,
  literalType,
  expressionBefore,
  steps,
  functionReturnType,
  completionContext,
  callAt,
  normalizeType,
};
