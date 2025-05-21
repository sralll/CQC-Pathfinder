: 'python manage.py shell << END
print("alive")
from django.contrib.auth import get_user_model
User = get_user_model()
if not User.objects.filter(username="lars").exists():
    User.objects.create_superuser("lars", "larsbeglinger@gmail.com", "admin0000")
END'

gunicorn CQCPathfinder.asgi:application -k uvicorn.workers.UvicornWorker --bind 0.0.0.0:$PORT