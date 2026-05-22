from pathlib import Path
import os
import dj_database_url
from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
FILES_DIR = os.path.join(BASE_DIR, 'jsonfiles')
MAPS_DIR = os.path.join(BASE_DIR, 'maps')

load_dotenv()

DEBUG = os.environ.get('DEBUG', 'False') == 'True'

SECRET_KEY = os.environ.get('SECRET_KEY')

ALLOWED_HOSTS = ['cqc-pathfinder.ch',
                 'www.cqc-pathfinder.ch',
                 'cqcpathfinder.up.railway.app',
                 'cqcpathfinder-staging.up.railway.app',
                 'localhost',
                 '127.0.0.1']

CSRF_TRUSTED_ORIGINS = [
    'https://cqc-pathfinder.ch',
    'https://www.cqc-pathfinder.ch',
    'https://cqcpathfinder.up.railway.app',
    'https://cqcpathfinder-staging.up.railway.app',
                        
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "coursesetter",
    "pathfinding",
    "play",
    "main",
    "accounts",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "servestatic.middleware.ServeStaticMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "CQCPathfinder.urls"

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [
            BASE_DIR / 'coursesetter/templates',
            BASE_DIR / 'play/templates',
            BASE_DIR / 'templates',
        ],
        'APP_DIRS': True,
        'OPTIONS': {
            'debug': DEBUG,
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'
DEFAULT_FROM_EMAIL = 'webmaster@localhost'

if DEBUG:
    DATABASES = {
        'default': dj_database_url.config(
            default='postgres://lars:admin@localhost:5432/db'
        )
    }

if not DEBUG:
    DATABASES = {
        'default': dj_database_url.config(
            default=os.environ.get('DATABASE_URL')
        )
    }

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SECURE = not DEBUG

LOGIN_URL = '/login/'
LOGIN_REDIRECT_URL = '/'
LOGOUT_REDIRECT_URL = 'login'

LANGUAGE_CODE = "en-us"
TIME_ZONE = "CET"
USE_I18N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

STATIC_URL = '/static/'
STATICFILES_DIRS = [os.path.join(BASE_DIR, 'static')]
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')

STORAGES = {
    'default': {
        'BACKEND': 'django.core.files.storage.FileSystemStorage',
    },
    'staticfiles': {
        'BACKEND': 'servestatic.storage.CompressedManifestStaticFilesStorage',
    },
}

MEDIA_ROOT = os.environ.get('MEDIA_ROOT', '/app/media')
MEDIA_URL = '/media/'

UPLOAD_SECRET = os.environ.get('UPLOAD_SECRET', '')