from django.urls import path
#from .views import home_view
from . import views

urlpatterns = [
    path('', views.home_view, name='home'),
    path('account/', views.account_view, name='account'),  # Add this line
    path('results/', views.results_view, name='results'),  # Add this line
    path('published-files/', views.get_published_json_filenames, name='published_files'),
    path('get_user_summary/', views.get_user_summary, name='get_user_summary'),
]