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

    # First-play tutorial flags — true until the athlete completes the tutorial
    # on the respective device type. Device (desktop vs mobile) is decided
    # client-side in play.js, so we keep one flag per layout.
    first_play_desktop = models.BooleanField(default=True)
    first_play_mobile = models.BooleanField(default=True)

    # Persistent UI language preference (the durable source of truth that follows
    # the account across devices). Blank = no preference → fall back to the
    # language cookie / Accept-Language / settings.LANGUAGE_CODE. Validated
    # against settings.LANGUAGES in the switcher view (account.views.set_language)
    # and re-applied to the cookie on login (CQCPathfinder.views.LocaleLoginView).
    language = models.CharField(max_length=10, blank=True, default='')

    def __str__(self):
        return self.user.username


class Device(models.Model):
    team = models.OneToOneField(Team, null=True, blank=True, on_delete=models.CASCADE, related_name='device')
    mobile = models.PositiveIntegerField(default=0)
    desktop = models.PositiveIntegerField(default=0)

    def __str__(self):
        return f"{self.team.name} - Mobile: {self.mobile}, Desktop: {self.desktop}"
    
class Feedback(models.Model):
    user = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True, related_name='feedback')
    comment = models.TextField(max_length=1000)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.user} - {self.created_at}"


class ForumThread(models.Model):
    """A discussion topic on the feedback forum."""
    author = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True,
                               related_name='forum_threads')
    title = models.CharField(max_length=160)
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    edited_at = models.DateTimeField(null=True, blank=True)  # set only on a user edit
    upvotes = models.ManyToManyField('auth.User', blank=True, related_name='upvoted_threads')

    class Meta:
        ordering = ['-created_at']

    @property
    def upvote_count(self):
        return self.upvotes.count()

    def __str__(self):
        return self.title


class ForumComment(models.Model):
    """A reply on a forum thread."""
    thread = models.ForeignKey(ForumThread, on_delete=models.CASCADE, related_name='comments')
    author = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True,
                               related_name='forum_comments')
    body = models.TextField(max_length=4000)
    created_at = models.DateTimeField(auto_now_add=True)
    edited_at = models.DateTimeField(null=True, blank=True)  # set only on a user edit
    upvotes = models.ManyToManyField('auth.User', blank=True, related_name='upvoted_comments')

    class Meta:
        ordering = ['created_at']

    @property
    def upvote_count(self):
        return self.upvotes.count()

    def __str__(self):
        return f"Re: {self.thread.title} ({self.created_at:%Y-%m-%d})"