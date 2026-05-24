from django.db.models.signals import post_save
from django.dispatch import receiver
from account.models import Profile
from .models import EditorSettings

@receiver(post_save, sender=Profile)
def create_editor_settings(sender, instance, created, **kwargs):
    if created:
        EditorSettings.objects.create(profile=instance)