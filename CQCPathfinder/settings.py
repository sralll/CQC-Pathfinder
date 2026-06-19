from pathlib import Path
import os
import dj_database_url
from dotenv import load_dotenv
from django.utils.translation import gettext_lazy as _

BASE_DIR = Path(__file__).resolve().parent.parent
FILES_DIR = os.path.join(BASE_DIR, 'jsonfiles')
MAPS_DIR = os.path.join(BASE_DIR, 'maps')

# Anchor the .env lookup to BASE_DIR so the same env is picked up regardless of
# where the process is launched from (manage.py, uvicorn started in a parent
# shell, IDE run configs, etc.). Without this, an uvicorn launched outside the
# project dir loads no .env → DEBUG defaults to False → SESSION_COOKIE_SECURE
# flips to True → browsers refuse to send the sessionid over plain HTTP and
# every authed endpoint 302s to /login/.
load_dotenv(BASE_DIR / ".env")

DEBUG = os.environ.get('DEBUG', 'False') == 'True'

SECRET_KEY = os.environ.get('SECRET_KEY')

ALLOWED_HOSTS = ['cqc-pathfinder.ch',
                 'www.cqc-pathfinder.ch',
                 'cqcpathfinder.up.railway.app',
                 'cqc-pathfinder-staging.up.railway.app',
                 'staging.cqc-pathfinder.ch',
                 'localhost',
                 '127.0.0.1']

CSRF_TRUSTED_ORIGINS = [
    'https://cqc-pathfinder.ch',
    'https://www.cqc-pathfinder.ch',
    'https://cqcpathfinder.up.railway.app',
    'https://cqc-pathfinder-staging.up.railway.app',
    'https://staging.cqc-pathfinder.ch',    
]

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "CQCPathfinder",
    "coursesetter",
    "play",
    "accounts",
    "account",
    "project",
    "results",
    #"admin_reorder",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "servestatic.middleware.ServeStaticMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    # LocaleMiddleware must sit after SessionMiddleware (it reads the language
    # from the session/cookie) and before CommonMiddleware (which may need the
    # active language for URL handling).
    "django.middleware.locale.LocaleMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    # Require login for every view by default; unauthenticated requests are
    # redirected to LOGIN_URL with ?next=<path> so the user lands back on the
    # page they wanted after logging in. Public views opt out with the
    # @login_not_required decorator (see CQCPathfinder/urls.py + internal_views).
    "django.contrib.auth.middleware.LoginRequiredMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    #"admin_reorder.middleware.ModelAdminReorder",
]

ADMIN_REORDER = (
    {
        'app': 'auth',
        'label': 'Account',
        'models': (
            'auth.User',
            'account.Profile',
            'account.Team',
            'account.Role',
            'account.Device',
            'account.Feedback',
        )
    },
    {
        'app': 'project',
        'label': 'Editor',
        'models': (
            'project.File',
        )
    }
)

ROOT_URLCONF = "CQCPathfinder.urls"

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [
            BASE_DIR / 'templates',
        ],
        'APP_DIRS': True,
        'OPTIONS': {
            'debug': DEBUG,
            'context_processors': [
                'django.template.context_processors.debug',
                'django.template.context_processors.request',
                'django.template.context_processors.i18n',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
                'account.context_processors.user_context',
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

# English is the source language (msgids in code are English); de/fr/it are
# translation catalogs under LOCALE_PATHS. The language is selected via the
# cookie/session switcher (set_language) — see CQCPathfinder/urls.py.
LANGUAGE_CODE = "en"
LANGUAGES = [
    ("en", _("English")),
    ("de", _("Deutsch")),
    ("fr", _("Français")),
    ("it", _("Italiano")),
]
LOCALE_PATHS = [BASE_DIR / "locale"]
TIME_ZONE = "CET"
USE_I18N = True
USE_TZ = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

CACHE_URL = os.environ.get('CACHE_URL') or os.environ.get('REDIS_URL')
if CACHE_URL:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.redis.RedisCache',
            'LOCATION': CACHE_URL,
        }
    }
else:
    CACHES = {
        'default': {
            'BACKEND': 'django.core.cache.backends.locmem.LocMemCache',
            'LOCATION': 'cqc-pathfinder',
        }
    }
STATS_TEAM_CACHE_TIMEOUT = int(os.environ.get('STATS_TEAM_CACHE_TIMEOUT', '600'))

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

# Multiplier for OCAD-derived editor scale. Keep at 1.0 unless a side-by-side
# comparison with an image import shows a systematic mismatch.
OCAD_EDITOR_SCALE_FACTOR = float(os.environ.get('OCAD_EDITOR_SCALE_FACTOR', '1.0'))
