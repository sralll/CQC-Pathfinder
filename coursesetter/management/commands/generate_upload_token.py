import secrets
from django.core.management.base import BaseCommand
from django.core.cache import cache

class Command(BaseCommand):
    help = 'Generate a one-time upload token'

    def handle(self, *args, **options):
        token = secrets.token_hex(32)
        cache.set('upload_token', token, timeout=3600)  # valid for 1 hour
        self.stdout.write(self.style.SUCCESS(f'Upload token: {token}'))