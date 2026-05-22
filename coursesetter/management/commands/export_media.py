import os
import zipfile
import tempfile
from django.http import FileResponse, Http404
from django.conf import settings
from django.contrib.auth.decorators import user_passes_test

# Security Check: Ensure only logged-in superusers can download your entire media library
@user_passes_test(lambda u: u.is_superuser)
def download_media_archive(request):
    # Use your app's configured MEDIA_ROOT path
    media_root = getattr(settings, 'MEDIA_ROOT', '/app/media')

    if not os.path.exists(media_root):
        raise Http404("Media directory does not exist on the server configuration.")

    # Create a secure temporary file on the server to build the archive
    temp_zip = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
    
    try:
        with zipfile.ZipFile(temp_zip.name, 'w', zipfile.ZIP_DEFLATED) as zip_file:
            for root, dirs, files in os.walk(media_root):
                for file in files:
                    file_path = os.path.join(root, file)
                    # Calculate relative path inside the zip so it doesn't look like /app/media/...
                    arcname = os.path.relpath(file_path, media_root)
                    zip_file.write(file_path, arcname)

        # Open the compiled zip to stream it back to your browser
        response = FileResponse(
            open(temp_zip.name, 'rb'), 
            content_type='application/zip',
            as_attachment=True,
            filename='production_media.zip'
        )
        
        return response

    except Exception as e:
        raise Http404(f"Error generating media archive: {str(e)}")