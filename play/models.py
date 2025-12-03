from django.db import models
from django.contrib.auth.models import User

class UserResult(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    filename = models.CharField(max_length=255, default='unknown')
    control_pair_index = models.IntegerField()
    choice_time = models.FloatField()
    selected_route = models.IntegerField(null=True, blank=True)
    selected_route_runtime = models.FloatField()
    shortest_route_runtime = models.FloatField()
    competition = models.BooleanField(default=True)
    timestamp = models.DateTimeField(auto_now_add=True)

    # New field for Kader
    kader = models.ForeignKey(
        "accounts.Kader",  # use string reference to avoid circular imports
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="user_results"
    )

    class Meta:
        indexes = [
            models.Index(fields=['filename']),
            models.Index(fields=['control_pair_index']),
        ]