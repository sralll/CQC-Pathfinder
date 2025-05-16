from django.urls import path
from . import views

urlpatterns = [
    path('', views.home_view, name='home'),
    path('statistik/', views.stats_view, name='stats_view'),  # Add this line
    path('results/', views.results_view, name='results'),  # Add this line
    path('get_published_files/', views.get_published_files, name='get_published_files'),
    path('fetch_plot_data/<str:filename>/', views.fetch_plot_data, name='fetch_plot_data'),
    path('stats/', views.user_game_stats, name='own_game_stats'),
    path('stats/<int:user_id>/', views.user_game_stats, name='user_game_stats'),
    path('user_list/', views.users_with_results, name='user_list'),
]