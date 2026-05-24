from django.urls import path
from . import views

urlpatterns = [
    path('debug/media_list/', views.list_media_json, name='list_media_json'),
    path('debug/upload_map/', views.upload_media_file, name='upload_media_file'),
    path('debug_file/<str:filename>', views.debug_file, name='debug_file'),
]