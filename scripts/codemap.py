#!/usr/bin/env python3
"""Where things are in the two big files, with current line numbers.

server.py and websh.js are single files by design (drop-in deployment,
no build step) and several thousand lines each. Read this map, then
read the part you need - not the whole file.

    scripts/codemap.py                 sections of both files
    scripts/codemap.py server          every class / function / method
    scripts/codemap.py client          every top-level function
    scripts/codemap.py tests           test classes and scenarios
    scripts/codemap.py <word>          any of the above whose name contains it

Generated from the source each time, so it cannot go stale.
"""
import ast
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY_SECTION = re.compile(r"^# ─── (.+?) ─+\s*$")
PY_SUB = re.compile(r"^    # ── (.+?) ─+\s*$")
JS_SECTION = re.compile(r"^// ── (.+?) ─+\s*$")
JS_FUNC = re.compile(r"^(?:async )?function (\w+)\s*\(([^)]*)")
JS_TEST = re.compile(r"""^test\((['"])(.+?)\1, """)


def read(name):
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        return f.read().splitlines()


def first_doc_line(node):
    doc = ast.get_docstring(node)
    return doc.strip().splitlines()[0] if doc else ""


def server_items():
    """(line, depth, kind, name, note) for server.py, in file order."""
    lines = read("server.py")
    items = []
    for i, text in enumerate(lines, 1):
        m = PY_SECTION.match(text)
        if m:
            items.append((i, 0, "section", m.group(1), ""))
        m = PY_SUB.match(text)
        if m:
            items.append((i, 2, "part", m.group(1), ""))
    tree = ast.parse("\n".join(lines))
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            items.append((node.lineno, 1, "def", node.name, first_doc_line(node)))
        elif isinstance(node, ast.ClassDef):
            items.append((node.lineno, 1, "class", node.name,
                          "%d lines" % (node.end_lineno - node.lineno + 1)))
            for sub in node.body:
                if isinstance(sub, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    items.append((sub.lineno, 3, "def",
                                  node.name + "." + sub.name, first_doc_line(sub)))
    return sorted(items)


def client_items():
    items = []
    for i, text in enumerate(read("websh.js"), 1):
        m = JS_SECTION.match(text)
        if m:
            items.append((i, 0, "section", m.group(1), ""))
            continue
        m = JS_FUNC.match(text)
        if m:
            items.append((i, 1, "function", m.group(1), "(" + m.group(2).strip() + ")"))
    return items


def test_items():
    items = []
    for path in sorted(glob.glob(os.path.join(ROOT, "tests/backend/test_*.py"))):
        rel = os.path.relpath(path, ROOT)
        with open(path, encoding="utf-8") as f:
            tree = ast.parse(f.read())
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                n = sum(1 for s in node.body
                        if isinstance(s, ast.FunctionDef) and s.name.startswith("test"))
                if n:
                    items.append((rel, node.lineno, node.name,
                                  "%d tests. %s" % (n, first_doc_line(node))))
    rel = "tests/frontend/test_connect.js"
    for i, text in enumerate(read(rel), 1):
        m = JS_TEST.match(text)
        if m:
            items.append((rel, i, m.group(2), ""))
    for path in sorted(glob.glob(os.path.join(ROOT, "tests/e2e/scenarios/*.mjs"))):
        rel = os.path.relpath(path, ROOT)
        with open(path, encoding="utf-8") as f:
            m = re.search(r"about: '([^']+)'", f.read())
        items.append((rel, 1, os.path.basename(path)[:-4], m.group(1) if m else ""))
    return items


def show(title, items, word=None, sections_only=False):
    out = []
    for line, depth, kind, name, note in items:
        if sections_only and kind != "section":
            continue
        if word and kind != "section" and word not in name.lower():
            continue
        if kind == "section":
            out.append((("" if sections_only else "\n") + "%6d  ── %s" % (line, name), True))
        else:
            note = (" - " + note) if note else ""
            text = "%6d  %s%s%s" % (line, "  " * depth, name, note)
            out.append((text[:118], False))
    if word:    # drop sections that ended up empty
        kept = []
        for i, (text, is_section) in enumerate(out):
            if is_section and (i + 1 == len(out) or out[i + 1][1]):
                continue
            kept.append((text, is_section))
        out = kept
    if out:
        print("%s" % title)
        for text, _ in out:
            print(text)
        print()
    return bool(out)


def show_tests(word=None):
    last = None
    found = False
    for rel, line, name, note in test_items():
        if word and word not in name.lower() and word not in note.lower():
            continue
        if rel != last:
            print(("\n" if found else "") + rel)
            last = rel
        found = True
        print(("%6d  %s%s" % (line, name, (" - " + note) if note else ""))[:118])
    if found:
        print()
    return found


def main(argv):
    what = argv[1].lower() if len(argv) > 1 else ""
    if what in ("-h", "--help"):
        print(__doc__)
        return 0
    if what == "server":
        show("server.py", server_items())
    elif what == "client":
        show("websh.js", client_items())
    elif what == "tests":
        show_tests()
    elif what:
        a = show("server.py", server_items(), what)
        b = show("websh.js", client_items(), what)
        print("tests")
        c = show_tests(what)
        if not (a or b or c):
            print("nothing named *%s*" % what)
            return 1
    else:
        show("server.py  (%d lines)" % len(read("server.py")), server_items(), sections_only=True)
        show("websh.js  (%d lines)" % len(read("websh.js")), client_items(), sections_only=True)
        print("More: scripts/codemap.py server | client | tests | <word>")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
