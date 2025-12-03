from django.db import models
from django.contrib.auth.models import User

class Kader(models.Model):
    name = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class UserProfile(models.Model):
    user = models.OneToOneField(User, on_delete=models.CASCADE)
    kader = models.ForeignKey(
        Kader,
        on_delete=models.SET_NULL,
        null=True,
        blank=True
    )

    def __str__(self):
        return self.user.username
    
class DeviceCounter(models.Model):
    mobile_count = models.PositiveIntegerField(default=0)
    desktop_count = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"Mobile: {self.mobile_count}, Desktop: {self.desktop_count}"