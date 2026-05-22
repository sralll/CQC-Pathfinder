import os
import shutil
import tempfile
from django.http import FileResponse, Http404
from django.conf import settings
from django.contrib.auth.decorators import user_passes_test

@user_passes_test(lambda u: u.is_superuser)
def download_media_archive(request):
    # Use your app's configured MEDIA_ROOT path (usually /app/media on Railway)
    media_root = getattr(settings, 'MEDIA_ROOT', '/app/media')

    # Sanity check: Ensure directory exists and isn't completely empty
    if not os.path.exists(media_root) or not os.listdir(media_root):
        raise Http404("Media directory is missing or empty on the cloud volume server.")

    # Create a secure temporary directory to hold the output zip
    temp_dir = tempfile.mkdtemp()
    output_zip_base = os.path.join(temp_dir, 'production_media')

    try:
        # shutil.make_archive handles all threading, file locks, and structures perfectly
        # It creates a file named: production_media.zip
        archive_path = shutil.make_archive(
            base_name=output_zip_base,
            format='zip',
            root_dir=media_root
        )

        # FileResponse natively blocks up files chunk-by-chunk under the hood.
        # This keeps RAM light while entirely avoiding proxy timeout drops.
        response = FileResponse(
            open(archive_path, 'rb'),
            content_type='application/x-zip-compressed',
            as_attachment=True,
            filename='production_media.zip'
        )
        
        return response

    except Exception as e:
        raise Http404(f"Error compiling media archive: {str(e)}")