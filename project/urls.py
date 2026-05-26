from django.urls import path
from . import views

urlpatterns = [
    path('', views.editor, name='editor'),
    path('files/', views.get_files, name='get_files'),
    path('publish/<int:file_id>/', views.toggle_publish, name='toggle_publish'),
]