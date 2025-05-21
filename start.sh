# Create superuser using environment variables if it doesn't exist
python manage.py shell <<EOF
import os
from django.contrib.auth import get_user_model

User = get_user_model()
username = os.environ.get('DJANGO_SUPERUSER_USERNAME', 'lars')
email = os.environ.get('DJANGO_SUPERUSER_EMAIL', 'larsbeglinger@gmail.com')
password = os.environ.get('DJANGO_SUPERUSER_PASSWORD', 'changeme0000')

if not User.objects.filter(username=username).exists():
    User.objects.create_superuser(username=username, email=email, password=password)
EOF

exec gunicorn CQCPathfinder.asgi:application --bind 0.0.0.0:$PORT