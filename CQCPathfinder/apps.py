from django.apps import AppConfig


class CQCPathfinderConfig(AppConfig):
    name = "CQCPathfinder"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from . import admin_extensions
        admin_extensions.install()
