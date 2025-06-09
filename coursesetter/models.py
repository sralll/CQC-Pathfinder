from django.db import models

class publishedFile(models.Model):
    filename = models.CharField(max_length=255, unique=True)
    published = models.BooleanField(default=False)
    ncP  = models.PositiveIntegerField(null=True, blank=True)
    author = models.CharField(max_length=255, blank=True)

    data = models.JSONField(null=True, blank=True)  # Stores the JSON blob
    last_edited = models.DateTimeField(auto_now=True)  # Updates on every save

    def __str__(self):
        return self.filename

