from django.urls import path

from . import play_views

urlpatterns = [
    path('', play_views.index, name='results_home'),
    path('infinity/', play_views.infinite_play, name='infinity_play'),
    path('infinity/mask-maps/', play_views.infinite_mask_maps, name='infinity_mask_maps'),
    path('infinity/user-stats/', play_views.infinite_user_stats, name='infinity_user_stats'),
    path('infinity/submit-choice/', play_views.submit_infinite_choice, name='submit_infinity_choice'),
    path('infinity/report-route/', play_views.report_infinite_route, name='report_infinity_route'),
    path('tutorial/', play_views.play_tutorial, name='play_tutorial'),
    path('tutorial-complete/', play_views.tutorial_complete, name='play_tutorial_complete'),
    path('<int:file_id>/<str:mode>/', play_views.play, name='play'),
    path('get-files/', play_views.get_files, name='play_get_files'),
    path('get-file/<int:file_id>/', play_views.get_file, name='play_get_file'),
    path('get-map/<str:filename>/', play_views.get_map, name='play_get_map'),
    path('submit-result/', play_views.submit_result, name='submit_result'),
]
