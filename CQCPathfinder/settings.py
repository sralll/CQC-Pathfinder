from pathlib import Path
import os
import dj_database_url
import whitenoise
from django.core.files.storage import default_storage

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent
FILES_DIR = os.path.join(BASE_DIR, 'jsonfiles')
MAPS_DIR = os.path.join(BASE_DIR, 'maps')

# SECURITY WARNING: don't run with debug turned on in production!
DEBUG = False

# Quick-start development settings - unsuitable for production
# See https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/

SECRET_KEY = os.environ.get('SECRET_KEY')

ALLOWED_HOSTS = ['cqcpathfinder.onrender.com', 'localhost', '127.0.0.1']

CSRF_TRUSTED_ORIGINS = [
    'https://cqcpathfinder.onrender.com',
]

# Application definition
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "coursesetter",
    "play",
    "main",
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
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = "CQCPathfinder.wsgi.application"

EMAIL_BACKEND = 'django.core.mail.backends.console.EmailBackend'  # For development
DEFAULT_FROM_EMAIL = 'webmaster@localhost'

# Database
# https://docs.djangoproject.com/en/5.2/ref/settings/#databases

if DEBUG:
    DATABASES = {
        'default': {
            'ENGINE': 'django.db.backends.postgresql',
            'NAME': 'db',
            'USER': 'lars',
            'PASSWORD': 'admin',
            'HOST': 'localhost',
            'PORT': '5432',
        }
    }

if not DEBUG:
    DATABASES = {
        'default': dj_database_url.config(
            default=os.environ.get('DATABASE_URL')
        )
    }


# Password validation
# https://docs.djangoproject.com/en/5.2/ref/settings/#auth-password-validators

AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.CommonPasswordValidator",
    },
    {
        "NAME": "django.contrib.auth.password_validation.NumericPasswordValidator",
    },
]

SECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')

CSRF_COOKIE_SECURE = not DEBUG
SESSION_COOKIE_SECURE = not DEBUG

LOGIN_URL = '/login/'
LOGIN_REDIRECT_URL = '/'


# Internationalization
# https://docs.djangoproject.com/en/5.2/topics/i18n/

LANGUAGE_CODE = "en-us"

TIME_ZONE = "CET"

USE_I18N = True

USE_TZ = True

# Default primary key field type
# https://docs.djangoproject.com/en/5.2/ref/settings/#default-auto-field

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

INSTALLED_APPS += ['storages']

AWS_ACCESS_KEY_ID = os.environ.get('AWS_ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = os.environ.get('AWS_SECRET_ACCESS_KEY')
AWS_STORAGE_BUCKET_NAME = os.environ.get('AWS_STORAGE_BUCKET_NAME')
AWS_S3_REGION_NAME = 'eu-north-1'

AWS_S3_CUSTOM_DOMAIN = '%s.S3.AMAZONAWS.COM' % AWS_STORAGE_BUCKET_NAME

AWS_S3_FILE_OVERWRITE = True
AWS_DEFAULT_ACL = None
AWS_S3_ADDRESSING_STYLE = "virtual"

STATIC_URL = '/static/'
STATICFILES_DIRS = [os.path.join(BASE_DIR, 'static')]
STATIC_ROOT = os.path.join(BASE_DIR, 'staticfiles')  # used in collectstatic for prod

STORAGES = {
    'default': {
        'BACKEND': 'storages.backends.s3boto3.S3Boto3Storage',
    },
    'staticfiles': {
        "BACKEND": "servestatic.storage.CompressedManifestStaticFilesStorage",
    },
}