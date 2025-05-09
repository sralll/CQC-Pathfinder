from django.db import models
from django.contrib.auth.models import User

class UserResult(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    filename = models.CharField(max_length=255, default='unknown')  # ← new field
    control_pair_index = models.IntegerField()
    choice_time = models.FloatField()
    selected_route_runtime = models.FloatField()
    shortest_route_runtime = models.FloatField()
    timestamp = models.DateTimeField(auto_now_add=True)


    class Meta:
        indexes = [
            models.Index(fields=['filename']),
            models.Index(fields=['control_pair_index']),
        ]