from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect
from .models import Profile, Team

@login_required
def switch_team(request, team_id):
    team = get_object_or_404(Team, id=team_id)
    profile = request.user.profile
    if profile.teams.filter(id=team_id).exists():
        profile.active_team = team
        profile.save()
    return redirect(request.META.get('HTTP_REFERER', '/'))