from django.db import models
from django.contrib.auth.models import User

class publishedFile(models.Model):
    filename = models.CharField(max_length=255, unique=True)
    published = models.BooleanField(default=False)

    def __str__(self):
        return self.filename
