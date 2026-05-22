import os
import tarfile
import tempfile
from django.conf import settings
from django.contrib.admin.views.decorators import staff_member_required
from django.http import StreamingHttpResponse


@staff_member_required
def export_media(request):
    media_root = settings.MEDIA_ROOT

    def stream_tar(tmp_path):
        with open(tmp_path, 'rb') as f:
            while chunk := f.read(8192):
                yield chunk

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix='.tar.gz')
    tmp.close()

    try:
        with tarfile.open(tmp.name, 'w:gz') as tf:
            tf.add(media_root, arcname='media')

        response = StreamingHttpResponse(stream_tar(tmp.name), content_type='application/gzip')
        response['Content-Disposition'] = 'attachment; filename="media_export.tar.gz"'
        response['X-Accel-Buffering'] = 'no'
        return response

    finally:
        os.unlink(tmp.name)