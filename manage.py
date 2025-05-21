#!/usr/bin/env python
import os
import sys
from django.core.asgi import get_asgi_application

# Load environment variables
#from dotenv import load_dotenv
#load_dotenv()

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'CQCPathfinder.settings')

application = get_asgi_application()

def main():
    """Run administrative tasks."""
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "CQCPathfinder.settings")
    try:
        from django.core.management import execute_from_command_line
    except ImportError as exc:
        raise ImportError(
            "Couldn't import Django. Are you sure it's installed and "
            "available on your PYTHONPATH environment variable? Did you "
            "forget to activate a virtual environment?"
        ) from exc
    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()