# Agent rules — CQC Pathfinder

This file is tool-agnostic and applies to **every** coding agent working in this
repo (Claude Code, Codex, Cursor, Gemini, …). Claude-specific project setup
(dev server, agent login, roles) lives in `CLAUDE.md`; the rules below apply
regardless of which agent you are.

## Translation discipline (mandatory)

The app is user-facing in **four languages: English (source) + German, French,
Italian**, via native Django i18n. User-facing text keeps getting hard-coded —
this is a bug, treat it like one.

**Rule: never hard-code user-facing text.** Anything a user can read in the UI
must go through gettext: button labels, menu items, headings, tooltips,
`title`/`aria-label`/`placeholder` attributes, empty states, warnings, error and
status messages, modal text, confirm dialogs.

How to mark strings (English text is the msgid):

| Where | How |
|---|---|
| Templates (`.html`) | `{% trans "Save" %}` / `{% blocktrans %}…{% endblocktrans %}` |
| Python (`.py`) | `from django.utils.translation import gettext_lazy as _` → `_("Save")` |
| JavaScript (`.js`) | `gettext("Save")` — global from the `/jsi18n/` catalog (djangojs domain) |

Workflow — the GNU gettext binaries are **not** installed, so `makemessages` /
`compilemessages` will not work. Use the repo's own toolchain:

1. Write the English string in code, wrapped as above.
2. Add a row to `locale/source_messages.py` — `DJANGO` dict for `.py`/`.html`
   strings, `DJANGOJS` for `.js` strings:
   `"Save": ("Speichern", "Enregistrer", "Salva"),`  *(order: de, fr, it)*
3. Run `python scripts/manage_translations.py --check` (finds msgids missing
   from the table), then `--build` (writes the `.po`/`.mo` files).
4. A task touching user-facing text is **not done** until `--check` is clean.
   Restart the dev server so the rebuilt `.mo` catalogs are picked up.

**Anglicism exception.** If the English term is what a German/French/Italian
speaker would naturally use, keep the English word *as the translation* —
e.g. "Play" stays "Play" in German ("Spielen" would sound off); existing
examples: "Editor", "Auto-Jump", "Auto-Pathfind". This is an exception for the
*translation value only*: the string must **still** be wrapped in gettext and
still get its row in `source_messages.py` (with identical text where English is
kept), so it can be changed later without touching code. When unsure whether a
term should stay English, ask rather than guess.

Style: match the existing catalog — informal address (German "du", French "tu"),
Swiss German spelling (no "ß": "Schliessen", not "Schließen").

Out of scope (no translation needed): `console.log`/debug output, code comments,
log lines, exception messages aimed at developers, internal identifiers and CSV
column keys.
