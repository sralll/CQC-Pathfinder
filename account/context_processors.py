def user_context(request):
    if not request.user.is_authenticated:
        return {}
    try:
        profile = request.user.profile
        teams = profile.teams.all()
        return {
            'user_profile': profile,
            'user_teams': teams,
            'active_team': profile.active_team,
        }
    except Exception:
        return {}