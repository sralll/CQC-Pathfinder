from accounts.views import create_user_profiles
from django.urls import path


urlpatterns = [
    # ... your other urls
    path('admin/create_profiles/', create_user_profiles),
]