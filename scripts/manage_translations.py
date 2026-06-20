"""Translation toolchain for CQC Pathfinder (gettext-binary-free).

Django's makemessages/compilemessages need the GNU gettext binaries
(xgettext/msgfmt), which are not installed on this machine. This script is a
self-contained replacement built around a single source of truth:

    locale/source_messages.py   →   DJANGO = {...}, DJANGOJS = {...}

Each entry maps the **English msgid** (exactly as written in code) to its German,
French and Italian translations:

    "Results": ("Resultate", "Résultats", "Risultati"),

English is the source language, so it needs no translation (the msgid *is* the
English text). Two domains:
  * DJANGO   — strings from .py and .html ({% trans %}, _(), gettext())
  * DJANGOJS — strings from .js (gettext())

Commands
--------
    python scripts/manage_translations.py --check    # scan code, diff against the table
    python scripts/manage_translations.py --build     # write locale/**/*.po and *.mo
    python scripts/manage_translations.py             # same as --build

Forward workflow (see docs/i18n.md):
  1. Mark a string in code with its English text:
       templates  {% trans "Save" %}
       python     _("Save")          (from django.utils.translation import gettext_lazy as _)
       javascript gettext("Save")    (global, from the /jsi18n/ catalog)
  2. Add a row to locale/source_messages.py: "Save": ("Speichern", "Enregistrer", "Salva")
  3. Run --check (catches msgids missing from the table), then --build.
"""
import array
import os
import re
import struct
import sys

try:                       # console may be cp1252 on Windows; msgids are UTF-8
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCALE_DIR = os.path.join(BASE_DIR, "locale")
LANGS = ("de", "fr", "it")
PLURAL = {
    "de": "nplurals=2; plural=(n != 1);",
    "fr": "nplurals=2; plural=(n > 1);",
    "it": "nplurals=2; plural=(n != 1);",
}

# Directories never scanned for translatable strings.
EXCLUDE_DIRS = {
    ".venv", "venv", "env", ".git", "__pycache__", "node_modules",
    "staticfiles", "locale", "migrations",
    "coursesetter", "play",          # deprecated apps — intentionally ignored
}
# Helper scripts that mention gettext()/trans in their own source.
EXCLUDE_FILES = {"manage_translations.py", "compile_messages.py"}

# ── Extraction regexes ────────────────────────────────────────────────────────
RE_TEMPLATE = re.compile(r"""\{%\s*trans(?:late)?\s+(["'])(.*?)\1""")
RE_PY = re.compile(r"""(?<![\w.])(?:gettext_lazy|gettext|ngettext|_)\(\s*(["'])(.*?)\1""")
RE_JS = re.compile(r"""(?<![\w.])gettext\(\s*(["'])(.*?)\1""")


def _unescape(s):
    return (s.replace("\\'", "'").replace('\\"', '"')
             .replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\"))


def _read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def collect():
    """Return {'django': set(msgid), 'djangojs': set(msgid)} found in code."""
    django, djangojs = set(), set()
    for root, dirs, files in os.walk(BASE_DIR):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            if name in EXCLUDE_FILES:
                continue
            path = os.path.join(root, name)
            if name.endswith(".py"):
                for m in RE_PY.finditer(_read(path)):
                    django.add(_unescape(m.group(2)))
            elif name.endswith(".html"):
                for m in RE_TEMPLATE.finditer(_read(path)):
                    django.add(_unescape(m.group(2)))
            elif name.endswith(".js"):
                for m in RE_JS.finditer(_read(path)):
                    djangojs.add(_unescape(m.group(2)))
    return {"django": django, "djangojs": djangojs}


def _table():
    """Import locale/source_messages.py and return (DJANGO, DJANGOJS)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "source_messages", os.path.join(LOCALE_DIR, "source_messages.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {"django": mod.DJANGO, "djangojs": mod.DJANGOJS}


def cmd_check():
    found = collect()
    table = _table()
    rc = 0
    for domain in ("django", "djangojs"):
        in_code = found[domain]
        in_table = set(table[domain])
        missing = sorted(in_code - in_table)   # used in code, no translation row
        unused = sorted(in_table - in_code)    # row exists, not used anywhere
        print(f"[{domain}] {len(in_code)} msgids in code, {len(in_table)} in table")
        if missing:
            rc = 1
            print(f"  MISSING from table ({len(missing)}):")
            for m in missing:
                print(f"    - {m!r}")
        if unused:
            print(f"  unused in table ({len(unused)}):")
            for m in unused:
                print(f"    ~ {m!r}")
    print("OK" if rc == 0 else "FAIL: add the missing msgids to locale/source_messages.py")
    return rc


def _esc(s):
    return s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _po_entry(msgid, msgstr):
    return f'msgid "{_esc(msgid)}"\nmsgstr "{_esc(msgstr)}"\n'


def _write_po(path, lang, entries):
    header = (
        'msgid ""\nmsgstr ""\n'
        '"MIME-Version: 1.0\\n"\n'
        '"Content-Type: text/plain; charset=UTF-8\\n"\n'
        '"Content-Transfer-Encoding: 8bit\\n"\n'
        f'"Language: {lang}\\n"\n'
        f'"Plural-Forms: {PLURAL[lang]}\\n"\n'
    )
    body = "\n".join(_po_entry(mid, entries[mid]) for mid in sorted(entries))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(header + "\n" + body)


def _generate_mo(catalog):
    catalog = dict(catalog)
    catalog.setdefault("", "")  # header entry
    keys = sorted(catalog)
    offsets, ids, strs = [], b"", b""
    for key in keys:
        bid, bstr = key.encode("utf-8"), catalog[key].encode("utf-8")
        offsets.append((len(ids), len(bid), len(strs), len(bstr)))
        ids += bid + b"\0"
        strs += bstr + b"\0"
    keystart = 7 * 4 + 16 * len(keys)
    valuestart = keystart + len(ids)
    ko, vo = [], []
    for o1, l1, o2, l2 in offsets:
        ko += [l1, o1 + keystart]
        vo += [l2, o2 + valuestart]
    out = struct.pack("Iiiiiii", 0x950412DE, 0, len(keys),
                      7 * 4, 7 * 4 + len(keys) * 8, 0, 0)
    out += array.array("i", ko).tobytes()
    out += array.array("i", vo).tobytes()
    return out + ids + strs


def cmd_build():
    table = _table()
    idx = {"django": 0, "djangojs": 1, "it": 2}
    for lang_i, lang in enumerate(LANGS):
        # Metadata header (the "" entry). Critical: the charset line is how
        # gettext knows the catalog is UTF-8 — without it Python decodes as ASCII.
        header = (
            "MIME-Version: 1.0\n"
            "Content-Type: text/plain; charset=UTF-8\n"
            "Content-Transfer-Encoding: 8bit\n"
            f"Language: {lang}\n"
            f"Plural-Forms: {PLURAL[lang]}\n"
        )
        for domain in ("django", "djangojs"):
            rows = table[domain]
            catalog = {mid: rows[mid][lang_i] for mid in rows}
            catalog[""] = header
            base = os.path.join(LOCALE_DIR, lang, "LC_MESSAGES", domain)
            _write_po(base + ".po", lang, catalog)
            with open(base + ".mo", "wb") as fh:
                fh.write(_generate_mo(catalog))
            print(f"built {os.path.relpath(base, BASE_DIR)}.po/.mo ({len(catalog)} entries)")
    return 0


def main(argv):
    if "--check" in argv:
        return cmd_check()
    return cmd_build()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
