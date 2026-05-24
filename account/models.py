from django.db import models
from django.contrib.auth.models import Group

class Role(Group):
    class Meta:
        proxy = True
        verbose_name = 'Role'
        verbose_name_plural = 'Roles'

class Team(models.Model):
    name = models.CharField(max_length=50, unique=True)
    shared_pool = models.BooleanField(default=False)

    def __str__(self):
        return self.name


class Profile(models.Model):
    user = models.OneToOneField('auth.User', on_delete=models.CASCADE, related_name='profile')
    teams = models.ManyToManyField(Team, blank=True)
    active_team = models.ForeignKey(Team, null=True, blank=True, on_delete=models.SET_NULL, related_name='active_users')

    def __str__(self):
        return self.user.username


class Device(models.Model):
    team = models.OneToOneField(Team, null=True, blank=True, on_delete=models.CASCADE, related_name='device')
    mobile = models.PositiveIntegerField(default=0)
    desktop = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"{self.team.name} - Mobile: {self.mobile}, Desktop: {self.desktop}"
    
class Feedback(models.Model):
    profile = models.ForeignKey(Profile, on_delete=models.SET_NULL, null=True, blank=True, related_name='feedback')
    comment = models.TextField(max_length=1000)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.profile.user.username} - {self.created_at}"