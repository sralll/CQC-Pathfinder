from django.db import models
from django.utils import timezone

class Label(models.Model):
    name  = models.CharField(max_length=100)
    team  = models.ForeignKey('account.Team', on_delete=models.CASCADE, related_name='labels')
    color = models.CharField(max_length=7, default='#5b8db8')

    class Meta:
        unique_together = ('name', 'team')

    def __str__(self):
        return self.name


class File(models.Model):
    name = models.CharField(max_length=255)
    team = models.ForeignKey('account.Team', on_delete=models.SET_NULL, null=True, blank=True, related_name='files')
    label = models.ForeignKey(Label, on_delete=models.SET_NULL, null=True, blank=True, related_name='files')
    published = models.BooleanField(default=False)
    author = models.CharField(max_length=255, blank=True)
    scale = models.FloatField(null=True, blank=True)
    scaled = models.BooleanField(default=False)
    map_file = models.CharField(max_length=255, blank=True)
    has_mask = models.BooleanField(default=False)
    blocked_terrain = models.JSONField(null=True, blank=True)
    last_edited = models.DateTimeField(default=timezone.now)
    batch_progress = models.JSONField(null=True, blank=True)
    locked_by  = models.ForeignKey('auth.User', on_delete=models.SET_NULL,
                                    null=True, blank=True, related_name='locked_files')
    locked_at  = models.DateTimeField(null=True, blank=True)

    deleted = models.BooleanField(default=False)
    
    def soft_delete(self):
        self.deleted = True
        self.save()

    class Meta:
        unique_together = ('name', 'team')

    def __str__(self):
        return f"{self.name} ({self.team})"

    @property
    def ncP(self):
        return self.control_pairs.count()


class ControlPair(models.Model):
    file = models.ForeignKey(File, on_delete=models.CASCADE, related_name='control_pairs')
    order = models.PositiveIntegerField()
    ziel = models.JSONField(null=True, blank=True)
    start = models.JSONField(null=True, blank=True)
    complex = models.BooleanField(default=False)

    class Meta:
        ordering = ['order']
        unique_together = ('file', 'order')

    def __str__(self):
        return f"CP {self.order} - {self.file.name}"

    def delete(self, *args, **kwargs):
        file = self.file
        order = self.order
        super().delete(*args, **kwargs)
        ControlPair.objects.filter(file=file, order__gt=order).update(order=models.F('order') - 1)


class Route(models.Model):
    control_pair = models.ForeignKey(ControlPair, on_delete=models.CASCADE, related_name='routes')
    order = models.PositiveIntegerField()
    rP = models.JSONField(null=True, blank=True)
    noA = models.FloatField(null=True, blank=True)
    pos = models.FloatField(null=True, blank=True)
    length = models.IntegerField(null=True, blank=True)
    run_time = models.FloatField(null=True, blank=True)
    elevation = models.IntegerField(null=True, blank=True)

    class Meta:
        ordering = ['order']
        unique_together = ('control_pair', 'order')

    def __str__(self):
        return f"Route {self.order} - CP {self.control_pair.order} - {self.control_pair.file.name}"

    def delete(self, *args, **kwargs):
        control_pair = self.control_pair
        order = self.order
        super().delete(*args, **kwargs)
        Route.objects.filter(control_pair=control_pair, order__gt=order).update(order=models.F('order') - 1)


class EditorSettings(models.Model):
    profile = models.OneToOneField('account.Profile', on_delete=models.CASCADE, related_name='editor_settings')
    auto_pathfind = models.BooleanField(default=True)
    auto_jump = models.BooleanField(default=True)
    autosave = models.BooleanField(default=False)

    def __str__(self):
        return f"{self.profile.user.username} - Editor Settings"
    
class FileSnapshot(models.Model):
    file = models.ForeignKey(File, on_delete=models.CASCADE, related_name='snapshots')
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True)
    trigger = models.CharField(max_length=100, blank=True)

    # File metadata at snapshot time
    name   = models.CharField(max_length=255, blank=True)
    label  = models.ForeignKey(Label, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    author = models.CharField(max_length=255, blank=True)

    # Snapshot of the full state at this point
    scale = models.FloatField(null=True, blank=True)
    map_file = models.CharField(max_length=255, blank=True)
    has_mask = models.BooleanField(default=False)
    blocked_terrain = models.JSONField(null=True, blank=True)
    control_pairs   = models.JSONField()  # full CP+route data as JSON blob
    n_control_pairs = models.IntegerField(default=0)
    n_routes        = models.IntegerField(default=0)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.file.name} — {self.created_at}"
