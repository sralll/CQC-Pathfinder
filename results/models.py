from django.db import models
from django.utils import timezone

class Choice(models.Model):
    user = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True, related_name='choices')
    control_pair = models.ForeignKey('project.ControlPair', on_delete=models.SET_NULL, null=True, blank=True, related_name='choices')
    selected_route = models.ForeignKey('project.Route', on_delete=models.SET_NULL, null=True, blank=True, related_name='selected_choices')

    choice_time = models.FloatField()
    competition = models.BooleanField(default=True)
    timestamp = models.DateTimeField(auto_now_add=True)

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