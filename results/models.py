from django.db import models
from django.utils import timezone

class Choice(models.Model):
    user = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True, related_name='choices')
    team = models.ForeignKey('account.Team', on_delete=models.SET_NULL, null=True, blank=True, related_name='choices')
    control_pair = models.ForeignKey('project.ControlPair', on_delete=models.SET_NULL, null=True, blank=True, related_name='choices')
    selected_route = models.ForeignKey('project.Route', on_delete=models.SET_NULL, null=True, blank=True, related_name='selected_choices')

    choice_time = models.FloatField()
    # Portion of choice_time that is reveal penalty (post-reveal time scaled up).
    # Stored separately so the penalty weighting can be re-tuned retrospectively
    # without losing the real decision time (choice_time - penalty).
    penalty     = models.FloatField(default=0)
    competition = models.BooleanField(default=True)
    timestamp   = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['user', 'control_pair'],
                name='unique_user_controlpair_choice'
            )
        ]

    def __str__(self):
        user = self.user.username if self.user else 'deleted'
        return f'{user} - Route {self.selected_route.order}' if self.selected_route else f'{user} - deleted Route'

    @property
    def selected_route_runtime(self):
        return self.selected_route.run_time if self.selected_route else None


class RandomChoice(models.Model):
    """One attempt of the procedurally-generated /play/random/ leg."""

    user         = models.ForeignKey('auth.User', on_delete=models.SET_NULL,
                                     null=True, blank=True, related_name='random_choices')
    correct      = models.BooleanField()
    choice_time  = models.FloatField()                         # seconds from reveal → decision
    shorter_time = models.FloatField()                         # seconds the optimal route would have taken
    longer_time  = models.FloatField()                         # seconds the slower route would have taken
    timestamp    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']

    @property
    def chosen_time(self):
        return self.shorter_time if self.correct else self.longer_time

    @property
    def pct_diff(self):
        """How much slower the LONGER route is vs the shorter, as a fraction."""
        if not self.shorter_time:
            return 0.0
        return (self.longer_time - self.shorter_time) / self.shorter_time

    def __str__(self):
        u = self.user.username if self.user else 'deleted'
        return f"{u} · {'✓' if self.correct else '✗'} · {self.choice_time:.1f}s"
