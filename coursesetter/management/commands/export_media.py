import os
import zipfile
from django.core.management.base import BaseCommand
from django.conf import settings

class Command(BaseCommand):
    help = "Packages all media files into a single zip output streamed to stdout"

    def handle(self, *args, **options):
        media_root = settings.MEDIA_ROOT
        
        if not os.path.exists(media_root):
            self.stderr.write(f"MEDIA_ROOT does not exist at {media_root}")
            return

        # Write the zip file directly to the standard output stream (sys.stdout.buffer)
        import sys
        with zipfile.ZipFile(sys.stdout.buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            for root, dirs, files in os.walk(media_root):
                for file in files:
                    file_path = os.path.join(root, file)
                    # Calculate relative path inside the zip archive
                    arcname = os.path.relpath(file_path, media_root)
                    zip_file.write(file_path, arcname)