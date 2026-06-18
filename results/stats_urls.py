from django.urls import path

from . import stats_views

urlpatterns = [
    path('', stats_views.stats_view, name='results_stats'),
    path('get-stats/', stats_views.get_user_stats, name='stats_get_stats'),
    path('get-athletes/', stats_views.get_team_athletes, name='stats_get_athletes'),
    path('get-table/', stats_views.get_stats_table, name='stats_get_table'),
]