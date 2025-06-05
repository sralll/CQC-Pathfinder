from django.db import models

class publishedFile(models.Model):
    filename = models.CharField(max_length=255, unique=True)
    published = models.BooleanField(default=False)
    ncP  = models.PositiveIntegerField(null=True, blank=True)
    author = models.CharField(max_length=255, blank=True)

    def __str__(self):
        return self.filename
