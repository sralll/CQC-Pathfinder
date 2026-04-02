from django.db import models

class publishedFile(models.Model):
    filename = models.CharField(max_length=255, unique=False)
    unique_filename = models.CharField(max_length=255, unique=True, null=True, blank=True)
    published = models.BooleanField(default=False)
    ncP = models.PositiveIntegerField(null=True, blank=True)
    author = models.CharField(max_length=255, blank=True)
    kader = models.ForeignKey(
        'accounts.Kader',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="published_files"
    )
    data = models.JSONField(null=True, blank=True)
    last_edited = models.DateTimeField(auto_now=True)
    batch_progress = models.JSONField(null=True, blank=True)

    def __str__(self):
        return self.filename