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
        indexes = [
            models.Index(fields=['team', 'competition', 'user'], name='choice_team_comp_user_idx'),
            models.Index(fields=['user', 'competition', 'timestamp'], name='choice_user_comp_time_idx'),
            models.Index(fields=['competition', 'control_pair'], name='choice_comp_cp_idx'),
        ]
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


class InfiniteChoice(models.Model):
    """One Infinity attempt; ``file=None`` identifies a generated-map leg."""

    user         = models.ForeignKey('auth.User', on_delete=models.SET_NULL,
                                     null=True, blank=True, related_name='infinite_choices')
    team         = models.ForeignKey('account.Team', on_delete=models.SET_NULL,
                                     null=True, blank=True, related_name='infinite_choices')
    file         = models.ForeignKey('project.File', on_delete=models.SET_NULL,
                                     null=True, blank=True, related_name='infinite_choices')
    correct      = models.BooleanField()
    choice_time  = models.FloatField()                         # seconds from reveal → decision
    shorter_time = models.FloatField()                         # seconds the optimal route would have taken
    longer_time  = models.FloatField()                         # seconds the slower route would have taken
    timestamp    = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['team', 'user'], name='infchoice_team_user_idx'),
            models.Index(fields=['user', 'timestamp'], name='infchoice_user_time_idx'),
            models.Index(fields=['user', 'file'], name='infchoice_user_file_idx'),
        ]

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


class ReportedInfinity(models.Model):
    """A user report for a procedurally-generated infinity route-choice leg."""

    user         = models.ForeignKey('auth.User', on_delete=models.SET_NULL,
                                     null=True, blank=True, related_name='reported_infinity')
    team         = models.ForeignKey('account.Team', on_delete=models.SET_NULL,
                                     null=True, blank=True, related_name='reported_infinity')
    timestamp    = models.DateTimeField(auto_now_add=True)

    seed         = models.PositiveIntegerField()
    pair_index   = models.PositiveIntegerField(null=True, blank=True)
    start_x      = models.FloatField()
    start_y      = models.FloatField()
    goal_x       = models.FloatField()
    goal_y       = models.FloatField()
    map_metres_per_unit = models.FloatField(null=True, blank=True)

    settings         = models.JSONField(default=dict, blank=True)
    route_indexes    = models.JSONField(default=list, blank=True)
    routes           = models.JSONField(default=list, blank=True)
    skipped_barriers = models.JSONField(default=list, blank=True)
    route_result     = models.JSONField(default=dict, blank=True)
    client_state     = models.JSONField(default=dict, blank=True)
    user_agent       = models.CharField(max_length=512, blank=True)

    class Meta:
        db_table = 'reported_infinity'
        ordering = ['-timestamp']
        indexes = [
            models.Index(fields=['seed', 'pair_index'], name='repinf_seed_pair_idx'),
            models.Index(fields=['team', 'timestamp'], name='repinf_team_time_idx'),
            models.Index(fields=['user', 'timestamp'], name='repinf_user_time_idx'),
        ]

    def __str__(self):
        u = self.user.username if self.user else 'deleted'
        return f"{u} reported seed {self.seed}"
