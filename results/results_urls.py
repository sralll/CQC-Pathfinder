from django.urls import path

from . import results_views

urlpatterns = [
    path('', results_views.results_overview, name='results_overview'),
    path('get-list/', results_views.get_files_overview, name='results_get_list'),
    path('<int:file_id>/', results_views.file_results, name='file_results'),
    path('<int:file_id>/get-data/', results_views.get_file_results, name='results_get_data'),
]