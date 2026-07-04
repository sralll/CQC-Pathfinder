"""Dev/agent test-account provisioning. DEBUG-only — never import from prod paths.

The staging DB is reseeded nightly, so the agent account must be re-creatable
on demand; every entry point (management command, /dev/agent-login/) calls
ensure_agent_user() and gets a valid Trainer account regardless of DB state.
"""
import os

from django.contrib.auth.models import Group, User

from account.models import Profile, Team

AGENT_USERNAME = os.environ.get('AGENT_USERNAME', 'agent')
# No password by default: the account is only enterable via the DEBUG-only
# /dev/agent-login/ endpoint (session login, no password check). The staging DB
# is shared with the deployed staging site, so a known fixed password here
# would be form-login-able by anyone at staging.cqc-pathfinder.ch. Set
# AGENT_PASSWORD in .env only if you need local form-login testing.
AGENT_PASSWORD = os.environ.get('AGENT_PASSWORD', '')
AGENT_TEAM = os.environ.get('AGENT_TEAM', 'Agents')


def ensure_agent_user(team_name=None, role_name='Trainer'):
    """Create or update the agent test user; returns the User.

    Idempotent: safe to call on every login. Attaches the role group and a
    team, and forces the UI language to English so agents can match on-page
    text against the English msgids in the code.

    The password is only (re)set when it doesn't already match the desired
    state: Django's session auth hash is derived from the password hash, so
    unconditionally re-hashing on every call would log out all other agent
    sessions each time one agent hits the login endpoint.
    """
    user, _ = User.objects.get_or_create(username=AGENT_USERNAME)
    if AGENT_PASSWORD:
        if not user.check_password(AGENT_PASSWORD):
            user.set_password(AGENT_PASSWORD)
    elif user.has_usable_password():
        user.set_unusable_password()
    user.is_active = True
    user.save()

    role, _ = Group.objects.get_or_create(name=role_name)
    user.groups.add(role)

    team, _ = Team.objects.get_or_create(name=team_name or AGENT_TEAM)
    profile, _ = Profile.objects.get_or_create(user=user)
    profile.teams.add(team)
    profile.active_team = team
    profile.language = 'en'
    profile.save()

    return user
