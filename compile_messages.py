"""Pure-Python .po -> .mo compiler.

A stand-in for GNU gettext's `msgfmt` / Django's `compilemessages` for
environments where the gettext binaries are not installed (e.g. Windows without
the gettext tools on PATH). Django reads the compiled .mo files at runtime; how
they were produced does not matter.

Usage:
    python compile_messages.py            # compile every .po under locale/

Once the gettext tools are installed you can switch back to the standard
`python manage.py compilemessages`; this script then becomes unnecessary.
"""
import array
import os
import struct
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LOCALE_DIR = os.path.join(BASE_DIR, "locale")

_ESCAPES = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "0": "\0"}


def _unescape(s):
    out = []
    it = iter(range(len(s)))
    i = 0
    while i < len(s):
        c = s[i]
        if c == "\\" and i + 1 < len(s):
            out.append(_ESCAPES.get(s[i + 1], s[i + 1]))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _parse_quoted(line):
    """Return the content of the first "..."-quoted span on the line."""
    first = line.index('"')
    last = line.rindex('"')
    return _unescape(line[first + 1:last])


def parse_po(path):
    """Parse a (simply-formatted) .po file into a {msgid: msgstr} dict."""
    catalog = {}
    msgid = msgstr = None
    mode = None  # 'id' or 'str'
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("msgid "):
                if msgid is not None and mode is not None:
                    catalog[msgid] = msgstr or ""
                msgid = _parse_quoted(line)
                msgstr = ""
                mode = "id"
            elif line.startswith("msgstr "):
                msgstr = _parse_quoted(line)
                mode = "str"
            elif line.startswith('"'):
                chunk = _parse_quoted(line)
                if mode == "id":
                    msgid += chunk
                elif mode == "str":
                    msgstr += chunk
        if msgid is not None and mode is not None:
            catalog[msgid] = msgstr or ""
    return catalog


def generate_mo(catalog):
    """Serialize a {msgid: msgstr} dict into GNU .mo binary form."""
    keys = sorted(catalog.keys())
    offsets = []
    ids = strs = b""
    for key in keys:
        bid = key.encode("utf-8")
        bstr = catalog[key].encode("utf-8")
        offsets.append((len(ids), len(bid), len(strs), len(bstr)))
        ids += bid + b"\0"
        strs += bstr + b"\0"

    keystart = 7 * 4 + 16 * len(keys)
    valuestart = keystart + len(ids)
    koffsets = []
    voffsets = []
    for o1, l1, o2, l2 in offsets:
        koffsets += [l1, o1 + keystart]
        voffsets += [l2, o2 + valuestart]

    output = struct.pack(
        "Iiiiiii",
        0x950412DE,            # magic
        0,                     # version
        len(keys),             # number of entries
        7 * 4,                 # start of key index
        7 * 4 + len(keys) * 8, # start of value index
        0, 0,                  # hash table size/offset (unused)
    )
    output += array.array("i", koffsets).tobytes()
    output += array.array("i", voffsets).tobytes()
    output += ids
    output += strs
    return output


def main():
    if not os.path.isdir(LOCALE_DIR):
        print(f"No locale directory at {LOCALE_DIR}", file=sys.stderr)
        return 1
    count = 0
    for root, _dirs, files in os.walk(LOCALE_DIR):
        for name in files:
            if not name.endswith(".po"):
                continue
            po_path = os.path.join(root, name)
            mo_path = po_path[:-3] + ".mo"
            catalog = parse_po(po_path)
            with open(mo_path, "wb") as fh:
                fh.write(generate_mo(catalog))
            print(f"compiled {os.path.relpath(mo_path, BASE_DIR)} ({len(catalog)} entries)")
            count += 1
    print(f"done: {count} catalog(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
