import os
from django.core.management.base import BaseCommand
from django.conf import settings


class Command(BaseCommand):
    help = 'List all files in MEDIA_ROOT'

    def handle(self, *args, **options):
        media_root = settings.MEDIA_ROOT

        if not os.path.exists(media_root):
            self.stdout.write(self.style.ERROR(f'MEDIA_ROOT does not exist: {media_root}'))
            return

        total_count = 0
        total_size = 0

        self.stdout.write(f'\nListing: {media_root}\n')
        self.stdout.write(f'{"Path":<60} {"Size":>10}')
        self.stdout.write('-' * 72)

        for dirpath, dirnames, filenames in os.walk(media_root):
            # Show folder header
            rel_dir = os.path.relpath(dirpath, media_root)
            if rel_dir == '.':
                rel_dir = '/'
            self.stdout.write(f'\n📁  {rel_dir}')

            for filename in sorted(filenames):
                filepath = os.path.join(dirpath, filename)
                size = os.path.getsize(filepath)
                rel_path = os.path.relpath(filepath, media_root)
                total_count += 1
                total_size += size
                self.stdout.write(f'  {rel_path:<58} {self._human_size(size):>10}')

        self.stdout.write('-' * 72)
        self.stdout.write(f'Total: {total_count} files — {self._human_size(total_size)}\n')

    def _human_size(self, size_bytes):
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size_bytes < 1024:
                return f'{size_bytes:.1f} {unit}'
            size_bytes /= 1024
        return f'{size_bytes:.1f} TB'