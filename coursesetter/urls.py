from django.urls import path
from . import views

urlpatterns = [
    path('', views.index, name='coursesetter'),
    path('get-files/', views.get_files, name='get_files'),
    path('load-file/<str:filename>/', views.load_file, name='load_file'),
    path('maps/<str:filename>/', views.serve_map_image, name='serve_map_image'),  # New line
    path('file-exists/<str:filename>/', views.check_file_exists, name='file_exists'),
    path('save-file/', views.save_file, name='save_file'),
    path('delete-file/<str:filename>/', views.delete_file, name='delete_file'),
    path('upload/', views.upload_map, name='upload_map'),
    path('toggle-publish/<str:filename>/', views.toggle_publish, name='toggle_publish'),
]