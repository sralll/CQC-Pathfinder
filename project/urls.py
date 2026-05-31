from django.urls import path
from . import views

urlpatterns = [
    path('', views.editor, name='editor'),
    path('files/', views.get_files, name='get_files'),
    path('publish/<int:file_id>/', views.toggle_publish, name='toggle_publish'),
    path('open/<int:file_id>/', views.open_file, name='open_file'),
    path('map/<str:filename>', views.get_map, name='get_map'),
    path('generate-mask/', views.generate_mask, name='generate_mask'),
    path('save-mask/',     views.save_mask,     name='save_mask'),
    path('save/',                   views.save_file,       name='save_file'),
    path('save-element/',           views.save_element,    name='save_element'),
    path('save-cp-order/',          views.save_cp_order,   name='save_cp_order'),
    path('delete-element/',         views.delete_element,  name='delete_element'),
    path('save-snapshot/',          views.save_snapshot,   name='save_snapshot'),
    path('snapshots/<int:file_id>/',          views.get_snapshots,      name='get_snapshots'),
    path('snapshots/<int:snapshot_id>/load/', views.load_snapshot,      name='load_snapshot'),
    path('debug/sync-has-mask/', views.sync_has_mask, name='sync_has_mask'),
]