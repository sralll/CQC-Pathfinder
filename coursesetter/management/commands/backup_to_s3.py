import json
from datetime import timedelta
from django.utils import timezone
from django.core.management.base import BaseCommand
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage
from coursesetter.models import publishedFile

class Command(BaseCommand):
    help = 'Backup JSON files to S3 if modified in the last 24 hours.'

    def handle(self, *args, **options):
        now = timezone.now()
        since = now - timedelta(hours=24)

        recent_files = publishedFile.objects.filter(last_edited__gte=since)

        for f in recent_files:
            try:
                json_str = json.dumps(f.data, ensure_ascii=False, indent=2)
                file_path = f'jsonfiles/{f.filename}'
                default_storage.save(file_path, ContentFile(json_str.encode('utf-8')))
                self.stdout.write(self.style.SUCCESS(f'Backed up {f.filename}'))
            except Exception as e:
                self.stderr.write(self.style.ERROR(f'Error backing up {f.filename}: {e}'))
