from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from account.dev import AGENT_PASSWORD, ensure_agent_user


class Command(BaseCommand):
    help = (
        "Ensure the agent test account exists (Trainer role, team, English UI). "
        "DEBUG-only; used by AI agents testing against the staging DB."
    )

    def add_arguments(self, parser):
        parser.add_argument('--team', default=None,
                            help="Attach the agent to this team instead of the default 'Agents' team.")
        parser.add_argument('--role', default='Trainer',
                            help="Role (auth Group) to grant. Default: Trainer.")

    def handle(self, *args, **options):
        if not settings.DEBUG:
            raise CommandError("Refusing to create the agent test user with DEBUG=False.")
        user = ensure_agent_user(team_name=options['team'], role_name=options['role'])
        pw = AGENT_PASSWORD if AGENT_PASSWORD else '<no password — use /dev/agent-login/>'
        self.stdout.write(self.style.SUCCESS(
            f"Agent user ready: {user.username} / {pw} "
            f"(role: {options['role']}, active team: {user.profile.active_team})"
        ))
