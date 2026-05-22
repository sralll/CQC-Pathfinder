import sys
import zipfile
from django.core.management.base import BaseCommand
from django.apps import apps

class Command(BaseCommand):
    help = "Packages all database-linked media assets into a zip stream sent to stdout"

    def handle(self, *args, **options):
        # Target standard out buffer for safe binary streaming
        stdout_buffer = sys.stdout.buffer

        with zipfile.ZipFile(stdout_buffer, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            # Crawl all models for file and image attachment fields
            for model in apps.get_models():
                file_fields = [f for f in model._meta.fields if f.get_internal_type() in ['FileField', 'ImageField']]
                if not file_fields:
                    continue

                for item in model.objects.all():
                    for field in file_fields:
                        file_attr = getattr(item, field.name)
                        # Ensure the record has an actual file attached
                        if file_attr and file_attr.name:
                            file_name = file_attr.name
                            try:
                                # Use Django's storage abstraction layer to open the file securely
                                with file_attr.open('rb') as active_file:
                                    # Write the binary data directly into the archive bundle
                                    zip_file.write_message = active_file.read()
                                    zip_file.writestr(file_name, zip_file.write_message)
                            except Exception as e:
                                # Send errors to stderr so they don't corrupt our binary stream
                                self.stderr.write(f"Skipping {file_name}: {str(e)}")