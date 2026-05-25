from django.urls import path
from . import views

urlpatterns = [
    path('', views.editor, name='editor'),
    path('files/', views.get_files, name='get_files'),
]