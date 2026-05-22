import os
import zipfile
import tempfile
from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import StreamingHttpResponse


@staff_member_required
def export_media(request):
    media_root = settings.MEDIA_ROOT

    def stream_zip(tmp_path):
        with open(tmp_path, 'rb') as f:
            while chunk := f.read(8192):
                yield chunk

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
    tmp.close()

    try:
        with zipfile.ZipFile(tmp.name, 'w', zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for root, dirs, files in os.walk(media_root):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, media_root)
                    zf.write(file_path, arcname)

        response = StreamingHttpResponse(stream_zip(tmp.name), content_type='application/zip')
        response['Content-Disposition'] = 'attachment; filename="media_export.zip"'
        response['X-Accel-Buffering'] = 'no'
        return response

    finally:
        os.unlink(tmp.name)