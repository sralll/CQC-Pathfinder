from django.urls import path
from . import views
from django.http import HttpResponse

urlpatterns = [
    path('', views.index, name='coursesetter'),
    path('get-files/', views.get_files, name='get_files'),
    path('load-file/<path:filename>/', views.load_file, name='load_file'),
    path('file-exists/<str:filename>/', views.check_file_exists, name='file_exists'),
    path('save-file/', views.save_file, name='save_file'),
    path('delete-file/<str:filename>/', views.delete_file, name='delete_file'),
    path('upload/', views.upload_map, name='upload_map'),
    path('toggle-publish/<str:filename>/', views.toggle_publish, name='toggle_publish'),
    path('get_map/<str:filename>', views.get_map_file, name='get_map_file'),
    path('get_mask/<str:filename>', views.get_mask, name='get_mask'),
    path('upload-mask/', views.upload_mask, name='upload_mask'),
    path('run_unet/', views.run_UNet, name='run_unet')]