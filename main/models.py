from django.db import models
from django.contrib.auth.models import User

class Feedback(models.Model):
    comment = models.TextField(max_length=1000)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.created_at}"