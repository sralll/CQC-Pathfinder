# Agent rules — CQC Pathfinder

This is the single, tool-agnostic source of project guidance for **every** coding
agent working in this repo (Claude Code, Codex, Cursor, Gemini, …). Tool-specific
instruction files should point here rather than duplicate these rules.

## Project environment

CQC Pathfinder is a Django ASGI app served with uvicorn. Local development uses
the **staging database**, which is reseeded nightly. Agents may create, modify,
and delete staging data while testing.

## Local dev server

The development server is usually already running at `http://127.0.0.1:8000`.
If it is not running, start it with:

```sh
uvicorn CQCPathfinder.asgi:application --reload
```

For an isolated preview, use `uvicorn-preview` on port 8765 when that helper is
available.

Static files are manifest-hashed. After editing CSS or JavaScript, run
`python manage.py collectstatic --noinput` and restart the server, otherwise the
changes may not appear.

## Logging in as an agent

Every view requires login through `LoginRequiredMiddleware`. Do not automate the
normal login form; CSRF protection and rate limiting make that brittle. Use the
DEBUG-only agent login endpoint instead:

```text
GET http://127.0.0.1:8000/dev/agent-login/
GET http://127.0.0.1:8000/dev/agent-login/?next=/stats/
```

One request provisions and logs in the development account, then redirects to
the requested page. The endpoint only exists with `DEBUG=True` and is never
routable in production.

| Setting | Value |
|---|---|
| Username | `agent` |
| Password | None; the account has an unusable password and can only use the development endpoint. Set `AGENT_PASSWORD` in `.env` only when local form-login testing is necessary. |
| Role | **Trainer** |
| Team | `Agents` (member and active team) |
| UI language | English, matching source msgids |

To provision the account without logging in, or choose another team or role:

```sh
python manage.py ensure_agent_user [--team <name>] [--role <name>]
```

The helper is in `account/dev.py`; its view is `dev_agent_login` in
`CQCPathfinder/views.py`, and its URL is conditionally registered in
`CQCPathfinder/urls.py`.

The agent account is not staff or superuser. Ask Lars before testing `/admin/`;
admin access is deliberately restricted by a per-team allow-list.

## Roles

Roles are `django.contrib.auth` groups (`account.Role` is a proxy). Views gate on
them with `account.decorators.role_required('<Role>')` or group queries such as
`user.groups.filter(name='Trainer')`. The **Trainer** role is required for most
trainer, statistics, and editor functionality.

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
column keys. Established exceptions from the original rollout: unexpected-failure
`alert()`/error strings were deliberately left in English (product decision), and
strings used as lookup **keys** must never be translated — keep a raw key and
translate only the display label (this has caused real bugs).
