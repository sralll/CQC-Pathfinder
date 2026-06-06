from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='results_home'),
    path('files/', views.get_files, name='results_files'),
    path('<int:file_id>/<str:mode>/', views.play, name='play'),
    path('file/<int:file_id>/', views.get_file, name='play_file'),
    path('map/<str:filename>/', views.get_map, name='play_map'),
    path('submit-result/', views.submit_result, name='submit_result'),
]
