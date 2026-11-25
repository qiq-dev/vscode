#!/usr/bin/env python3
"""Generates data/stdlib.json, the standard library the extension completes:
every function (signature, docs, and the import path it needs, if any) and
every class (properties and methods).

    python3 scripts/generate-stdlib.py [path to the qiq repository]

Functions and their docs come from the manual's source (docs/src/stdlib.py);
classes come from the standard library's own files (stdlib/*.qiq), with the
comments above each member as its docs. Run it again after the standard
library changes.
"""
import html
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def default_repository():
    """The qiq repository next to this extension's folder (../qiq), or the
    folder above it, where the extension used to live."""
    for candidate in (os.path.join(HERE, "..", "..", "qiq"), os.path.join(HERE, "..", "..")):
        if os.path.exists(os.path.join(candidate, "src", "compiler.rs")):
            return candidate
    sys.exit("can't find the qiq repository: give its path, as in python3 scripts/generate-stdlib.py ../qiq")


REPO = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else default_repository())
sys.path.insert(0, os.path.join(REPO, "docs", "src"))
sys.path.insert(0, os.path.join(REPO, "docs"))
import stdlib  # noqa: E402  (docs/src/stdlib.py)
from std_imports import module_of  # noqa: E402  (docs/std_imports.py)

def stdlib_modules():
    """The standard library's files, and the import path each needs (None:
    the prelude, available everywhere), from STDLIB_MODULES in
    src/compiler.rs, so they can't fall out of step."""
    source = open(os.path.join(REPO, "src", "compiler.rs")).read()
    table = source[source.index("const STDLIB_MODULES"):]
    table = table[: table.index("];")]
    modules = []
    for file, path in re.findall(r'\("([\w.]+\.qiq)",\s*(?:None|Some\("([^"]+)"\))', table):
        modules.append((file, path or None))
    if not modules:
        sys.exit("found no standard library modules in src/compiler.rs")
    return modules


MODULES = stdlib_modules()


def markdown(text):
    """The docs' HTML as Markdown, for hovers and completion details."""
    if not text:
        return ""
    text = re.sub(r"<code>(.*?)</code>", lambda m: "`" + re.sub(r"<[^>]+>", "", m.group(1)) + "`", text, flags=re.S)
    text = re.sub(r"<(strong|b)>(.*?)</\1>", r"**\2**", text, flags=re.S)
    text = re.sub(r"<(em|i)>(.*?)</\1>", r"*\2*", text, flags=re.S)
    text = re.sub(r"<li>", "- ", text)
    text = re.sub(r"</li>|</p>|<br>", "\n", text)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).strip()


def split_params(text):
    """Splits a parameter list at top-level commas (function types have
    their own, and a default such as "," is a string)."""
    parts, depth, current, quoted, escaped = [], 0, "", False, False
    for c in text:
        if quoted:
            current += c
            if escaped:
                escaped = False
            elif c == "\\":
                escaped = True
            elif c == '"':
                quoted = False
            continue
        if c == '"':
            quoted = True
        elif c in "([":
            depth += 1
        elif c in ")]":
            depth -= 1
        if c == "," and depth == 0:
            parts.append(current.strip())
            current = ""
        else:
            current += c
    if current.strip():
        parts.append(current.strip())
    return parts


def parse_param(text):
    # `...` ends a standard library method that takes the values for a
    # query's placeholders (see Function::binds_values in src/compiler.rs).
    if text.strip() == "...":
        return {"name": "values", "type": "...", "default": None, "variadic": True}
    # `string ...parts`: any number of strings, a string[] in the function.
    variadic = re.match(r"(.*?\S)\s*\.\.\.\s*([A-Za-z_]\w*)$", text.strip())
    if variadic:
        return {"name": variadic.group(2), "type": variadic.group(1) + "[]", "default": None, "variadic": True}
    default = None
    if "=" in text:
        text, default = text.split("=", 1)
        text, default = text.strip(), default.strip()
    match = re.match(r"(.*\S)\s+([A-Za-z_]\w*)$", text)
    return {"name": match.group(2), "type": match.group(1), "default": default}


def param_entry(p):
    """A function parameter from the manual; a variadic one (`string ...parts`)
    is written there with its element type, and is an array in the function."""
    entry = {"name": p["name"], "type": p["type"], "default": p.get("default"), "doc": markdown(p["description"])}
    if p.get("variadic"):
        entry["type"] += "[]"
        entry["variadic"] = True
    return entry


def functions():
    result = {}
    for category in stdlib.CATEGORIES:
        for function in category["functions"]:
            name = function["name"]
            result[name] = {
                "name": name,
                "params": [param_entry(p) for p in function["params"]],
                "returns": function["returns"],
                "summary": markdown(function["purpose"]),
                "doc": markdown(function["description"]),
                "module": module_of(name),
                "category": category["title"],
            }
    return result


MEMBER_START = re.compile(r"^\s*((?:(?:public|private|protected|static|final|abstract)\s+)*)function\s+(\w+)\s*\(")


def parse_member(line):
    """(modifiers, name, parameter text, return type) for a method line, or None."""
    start = MEMBER_START.match(line)
    if not start:
        return None
    depth, index = 1, start.end()
    while index < len(line) and depth:
        depth += {"(": 1, ")": -1}.get(line[index], 0)
        index += 1
    params = line[start.end():index - 1]
    rest = line[index:].strip()
    returns = None
    if rest.startswith(":"):
        returns = re.split(r"\s*[{;]\s*$|\s*\{", rest[1:].strip())[0].strip()
    return start.group(1), start.group(2), params, returns
PROPERTY = re.compile(r"^\s*((?:(?:public|private|protected|static|final|readonly)\s+)+)(.+?)\s+(\w+)\s*(?:=.*)?;")
CLASS = re.compile(r"^(?:(?:final|abstract)\s+)*(class|interface)\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w\s,]+?))?\s*\{")


def classes():
    """Public classes and their public members, from the stdlib's .qiq files."""
    result = {}
    for file, module in MODULES:
        lines = open(os.path.join(REPO, "stdlib", file)).read().split("\n")
        comment = []
        current = None
        depth = 0
        for line in lines:
            stripped = line.strip()
            if stripped.startswith("//"):
                comment.append(stripped[2:].strip())
                continue
            if depth == 0:
                match = CLASS.match(line)
                if match and not match.group(2).startswith("__"):
                    current = {
                        "name": match.group(2),
                        "kind": match.group(1),
                        "extends": match.group(3),
                        "final": line.lstrip().startswith("final"),
                        "module": module,
                        "doc": " ".join(comment).strip(),
                        "properties": [],
                        "methods": [],
                    }
                    result[current["name"]] = current
                elif match:
                    current = None
            elif depth == 1 and current is not None:
                member = parse_member(line)
                prop = PROPERTY.match(line) if not member else None
                if member:
                    modifiers, name, params, returns = member
                    visible = "private" not in modifiers and "protected" not in modifiers
                    if visible and (not name.startswith("__") or name == "__construct"):
                        current["methods"].append({
                            "name": name,
                            "static": "static" in modifiers,
                            "params": [parse_param(p) for p in split_params(params)],
                            "returns": (returns or "void").strip(),
                            "doc": " ".join(comment).strip(),
                        })
                elif prop:
                    modifiers, type_, name = prop.groups()
                    if "private" not in modifiers and "protected" not in modifiers:
                        current["properties"].append({
                            "name": name,
                            "type": type_.strip(),
                            "static": "static" in modifiers,
                            "readonly": "readonly" in modifiers,
                            "doc": " ".join(comment).strip(),
                        })
            comment = []
            depth += line.count("{") - line.count("}")
            if depth == 0 and not CLASS.match(line):
                current = None
    return result


# Methods the compiler provides rather than the standard library's files
# declare (see emit_query_as in src/compiler.rs): they read rows into the
# class the result is used as, which completion shows as T.
COMPILER_METHODS = {
    "Database": [
        ("queryAs", [{"name": "sql", "type": "string", "default": None}, {"name": "values", "type": "...", "default": None, "variadic": True}], "T[]",
         "Runs a query and reads each row into an object of the class the result is used as, as in `User[] users = db->queryAs(sql, ...);`: through its constructor, by parameter name, or its public properties."),
        ("queryOneAs", [{"name": "sql", "type": "string", "default": None}, {"name": "values", "type": "...", "default": None, "variadic": True}], "T",
         "The first row of a query read into an object of the class the result is used as, as in `User user = db->queryOneAs(sql, ...);`, or null when there is none."),
    ],
    "Cursor": [
        ("nextAs", [], "T", "The next row read into an object of the class the result is used as, as in `Event event = rows->nextAs();`, or null after the last."),
        ("fetchAs", [{"name": "count", "type": "int", "default": None}], "T[]",
         "Up to `count` more rows read into objects of the class the result is used as, as in `Event[] batch = rows->fetchAs(500);`."),
    ],
}


def add_compiler_methods(classes):
    for class_name, methods in COMPILER_METHODS.items():
        if class_name not in classes:
            continue
        for name, params, returns, doc in methods:
            classes[class_name]["methods"].append({"name": name, "static": False, "params": params, "returns": returns, "doc": doc})


def main():
    all_classes = classes()
    add_compiler_methods(all_classes)
    data = {
        "modules": [path for _, path in MODULES if path],
        "functions": functions(),
        "classes": all_classes,
    }
    out = os.path.join(HERE, "..", "data", "stdlib.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
        f.write("\n")
    print(f"wrote {os.path.relpath(out)}: {len(data['functions'])} functions, {len(data['classes'])} classes")


if __name__ == "__main__":
    main()
