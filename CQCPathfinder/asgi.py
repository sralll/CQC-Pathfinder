"""
ASGI config for gameplatform project.

It exposes the ASGI callable as a module-level variable named ``application``.

For more information on this file, see
https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/
"""

import os
from django.core.asgi import get_asgi_application

# Load environment variables
#from dotenv import load_dotenv
#load_dotenv()

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "CQCPathfinder.settings")

application = get_asgi_application()