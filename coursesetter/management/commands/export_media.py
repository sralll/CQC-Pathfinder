import os
import zipfile
import zipstream
from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import StreamingHttpResponse


@staff_member_required
def export_media(request):
    media_root = settings.MEDIA_ROOT

    def file_iterator(path):
        for root, dirs, files in os.walk(path):
            for file in files:
                file_path = os.path.join(root, file)
                arcname = os.path.relpath(file_path, media_root)
                yield file_path, arcname

    zf = zipstream.ZipFile(mode='w', compression=zipstream.ZIP_DEFLATED, allowZip64=True)

    for file_path, arcname in file_iterator(media_root):
        zf.write(file_path, arcname)

    response = StreamingHttpResponse(zf, content_type='application/zip')
    response['Content-Disposition'] = 'attachment; filename="media_export.zip"'
    response['X-Accel-Buffering'] = 'no'  # Disable proxy buffering (Nginx/Railway)
    return response