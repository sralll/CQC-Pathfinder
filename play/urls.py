from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='play_home'),
    path('get-files/', views.get_files, name='get_files'),
    path('load-file/<str:filename>/', views.load_file, name='load_file'),
    path('submit_result/', views.submit_result, name='submit_result'),
]