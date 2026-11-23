# qiq for Visual Studio Code

Language support for [qiq](https://github.com/qiq-dev/qiq): syntax highlighting, compile errors
as you type, completion, hovers, parameter hints, go to definition, and the
outline, for `.qiq` files,
plus highlighting for `qiq.mod` and `qiq.sum`.

## Features

- **Syntax highlighting** for qiq: keywords, types, strings and their
  escapes (an unsupported escape such as `\q` is marked), raw `...`
  strings, chars, numbers, block comments,
  declarations, calls, `->`, `?->`, and `::` access, `::class`,
  `instanceof`, `++` and compound assignments, `const` and `readonly`, named
  arguments, imports, and anonymous functions. A pattern written as a raw
  string in a `preg_*` call is highlighted as a regular expression: groups,
  classes, quantifiers, anchors, escapes, delimiters, and flags. `qiq.mod`
  and `qiq.sum` are highlighted too.
- **Compile errors as you type**: shortly after you stop typing, the
  extension runs `qiq check` on the file's unsaved text and underlines the
  error it reports, which also appears in the Problems panel. The compiler
  stops at the first error, so there is at most one per file. An error in an
  imported file is shown in that file and mentioned on the first line of the
  one you're editing. Type errors are reported at the start of the statement
  they're in, so when the message quotes a name or operator on that line
  (`variable 'y' is not declared`), that is what's underlined.
- **Completion**
  - Everything in scope: variables (with their types, including ones
    inferred from `x = new Item()`, `foreach` loops, and
    `if (shape instanceof Circle circle)`), parameters, `this`, your
    functions and classes, imported names, keywords, and types.
  - **The standard library, with auto-import**: choosing `file_get_contents`
    adds `import file_get_contents from "std/file";`, or adds the name to an
    existing import from `std/file`. Prelude functions such as `trim` and
    `len` need no import.
  - **Members after `->` and `?->`**, worked out from declared types,
    through chains such as `basket->first()->name`, `user?->address?->city`,
    and `items[0]->`, across files and modules, including inherited members
    and properties declared by constructor promotion
    (`function __construct(public readonly int x)`). Private and protected
    members only appear where they're accessible.
  - **Static members and constants after `::`**, `class` after `Class::`
    and `value::`, and `parent::` / `self::` / `static::`.
  - **After `new`**: classes you can instantiate, with constructor hints.
  - **Import paths**: `std/` modules, your module path and the modules in
    `qiq.mod`, and files and directories; then the names a file exports, in
    `import | from "path";`.
  - **Snippets**: `function`, `class`, `foreach`, `for` (a `range` loop),
    `try`, `switch`, `httpserver`, and more.
- **Hovers** with signatures and docs, for the standard library and for
  your own code (from the `//` or `/** */` comment above a declaration).
- **Parameter hints** for functions, methods, constructors, and function
  values, following named arguments such as `timeout: 5`, and the values
  after a query's SQL (`db->query(sql, ...values)`).
- **Go to definition** for functions, classes, methods, and properties in
  your files and in modules.
- **Outline** of a file's classes, members, and functions.

Imports resolve the way the compiler resolves them: relative paths, your
module's path from `qiq.mod`, required modules (from a `replace` directory or
the module cache, `~/.cache/qiq/mod`), and `std/` paths.

## Installing

1. Download the `.vsix` file (for example `qiq-0.2.0.vsix`) from the
   [releases page](https://github.com/qiq-dev/vscode/releases).
2. Install it:

   ```sh
   code --install-extension qiq-0.2.0.vsix
   ```

   Or, in VS Code, open the Extensions view, click the **...** menu at the
   top, choose **Install from VSIX...**, and pick the file.
3. Reload VS Code if it asks you to.

To update, install the newer `.vsix` the same way. It replaces the old
version.

Highlighting, completion, hovers and the other editor features work on their
own. To see compile errors as you type, the `qiq` executable also needs to be
on your `PATH`. If it isn't, set `qiq.path` to where it is (see
[Settings](#settings)).

## Development

Open this folder in VS Code and press **F5** ("Run the qiq extension") to
start a window with the extension loaded.

To use your working copy in your normal VS Code, link the folder into your
extensions and reload the window:

```sh
ln -s "$PWD" ~/.vscode/extensions/qiq
```

To make a `.vsix` file to share or install with `code --install-extension`:

```sh
npx @vscode/vsce package
```

(The `publisher` in `package.json` is the Marketplace publisher ID used when
publishing.)

## How it works

There are no dependencies and no build step: the extension is plain
JavaScript.

| File | |
|---|---|
| `syntaxes/qiq.tmLanguage.json` | The TextMate grammar for highlighting |
| `syntaxes/qiq-mod.tmLanguage.json` | `qiq.mod` and `qiq.sum` |
| `language-configuration.json` | Comments, brackets, auto-closing, indentation |
| `snippets/qiq.json` | Snippets |
| `src/analysis.js` | Reads qiq source: declarations, scopes, expressions, the completion context |
| `src/symbols.js` | Imports, modules, and the standard library; types of expressions |
| `src/diagnostics.js` | Runs `qiq check` and reads the error it reports |
| `src/extension.js` | The VS Code providers and compile errors |
| `data/stdlib.json` | The standard library: generated, don't edit |

`src/analysis.js` reads unfinished code with patterns and bracket matching
rather than the compiler's parser, so it keeps working while you type, but it
doesn't check types or report errors. Compile errors come from the compiler
itself: `src/diagnostics.js` runs `qiq check --stdin <file>`, which compiles
the text it's given as that file (so imports resolve from where the file is)
without optimizing or linking, and reads the error it prints.

### Settings

| Setting | Default | |
|---|---|---|
| `qiq.path` | `qiq` | The qiq executable used to check for errors |
| `qiq.diagnostics.enabled` | `true` | Show compile errors as you type |

### The standard library data

`data/stdlib.json` comes from the manual's source (`docs/src/stdlib.py`), the
standard library's files (`stdlib/*.qiq`), and the list of its modules and
their import paths (`STDLIB_MODULES` in `src/compiler.rs`), in the qiq
repository; methods the compiler provides itself, such as `Database`'s
`queryAs`, are added by the script. After the standard library changes,
regenerate it:

```sh
python3 scripts/generate-stdlib.py [path to the qiq repository]
```

The path defaults to `../qiq`, the repository next to this folder.

### Tests

The tests need only Node, and VS Code includes one:

```sh
ELECTRON_RUN_AS_NODE=1 code test/run.js      # or: node test/run.js
```

With VS Code installed as a snap, run its Electron directly, since the `code`
launcher doesn't pass the script on:

```sh
ELECTRON_RUN_AS_NODE=1 /snap/code/current/usr/share/code/code test/run.js
```

- `test/analysis.test.js`: reading qiq, scopes, types across files and modules
- `test/diagnostics.test.js`: reading compiler errors
- `test/extension.test.js`: the completion, hover, parameter hint, definition,
  and outline providers, and compile errors (with the compiler in `$QIQ`, or
  one built in `../qiq/target`), against a stand-in for VS Code's API
- `test/grammar.test.js`: highlighting scopes, with the TextMate engine
  VS Code uses (found inside VS Code, or set `QIQ_VSCODE_APP` to its
  `resources/app` directory)

## License

The extension is licensed under the [MIT license](LICENSE).
