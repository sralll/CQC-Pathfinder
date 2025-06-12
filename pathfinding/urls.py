from django.urls import path
from . import views

urlpatterns = [
    path('get_mask/<str:filename>', views.get_mask, name='get_mask'),
    path('upload-mask/', views.upload_mask, name='upload_mask'),
    path('run_unet/', views.run_UNet, name='run_unet'),
    path("find/", views.find, name="find"),
]