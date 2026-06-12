from django.urls import path
from . import views

urlpatterns = [
    path('debug/media_list/', views.list_media_json, name='list_media_json'),
    path('debug/upload_map/', views.upload_media_file, name='upload_media_file'),
    path('debug/upload_editor_json/', views.upload_editor_json, name='upload_editor_json'),
    path('debug_file/<str:filename>', views.debug_file, name='debug_file'),
]