import os
from django.core.management.base import BaseCommand
from django.conf import settings


class Command(BaseCommand):
    help = 'Check MEDIA_ROOT path and contents'

    def handle(self, *args, **options):
        self.stdout.write(f'MEDIA_ROOT: {settings.MEDIA_ROOT}')
        self.stdout.write(f'Exists: {os.path.exists(settings.MEDIA_ROOT)}')

        maps_dir = os.path.join(settings.MEDIA_ROOT, 'maps')
        self.stdout.write(f'\nMaps dir: {maps_dir}')
        self.stdout.write(f'Exists: {os.path.exists(maps_dir)}')

        if os.path.exists(maps_dir):
            files = os.listdir(maps_dir)
            self.stdout.write(f'File count: {len(files)}')
            self.stdout.write('First 5 files:')
            for f in sorted(files)[:5]:
                self.stdout.write(f'  {f}')
        else:
            self.stdout.write(self.style.ERROR('Maps directory does not exist!'))