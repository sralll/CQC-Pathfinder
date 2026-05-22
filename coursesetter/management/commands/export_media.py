import os
import tarfile
from django.conf import settings
from django.core.management.base import BaseCommand


class Command(BaseCommand):
    help = 'Export media folder to a tar archive'

    def add_arguments(self, parser):
        parser.add_argument(
            '--output',
            default='/tmp/media_export.tar',
            help='Output path for the tar file (default: /tmp/media_export.tar)'
        )

    def handle(self, *args, **options):
        media_root = settings.MEDIA_ROOT
        output_path = options['output']

        self.stdout.write(f'Archiving {media_root} ...')

        with tarfile.open(output_path, 'w') as tf:
            tf.add(media_root, arcname='media')

        size_mb = os.path.getsize(output_path) / (1024 * 1024)
        self.stdout.write(self.style.SUCCESS(f'Done: {output_path} ({size_mb:.1f} MB)'))