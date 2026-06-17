from django.urls import path
from . import views
from . import UNet

urlpatterns = [
    path('', views.editor, name='editor'),
    path('files/', views.get_files, name='get_files'),
    path('publish/<int:file_id>/', views.toggle_publish, name='toggle_publish'),
    path('open/<int:file_id>/', views.open_file, name='open_file'),
    path('map/<str:filename>', views.get_map, name='get_map'),
    path('generate-mask/', UNet.generate_mask, name='generate_mask'),
    path('save-mask/',     views.save_mask,     name='save_mask'),
    path('mark-has-mask/', views.mark_has_mask, name='mark_has_mask'),
    path('save/',                   views.save_file,       name='save_file'),
    path('save-element/',           views.save_element,    name='save_element'),
    path('save-cp-order/',          views.save_cp_order,   name='save_cp_order'),
    path('delete-element/',         views.delete_element,  name='delete_element'),
    path('save-snapshot/',          views.save_snapshot,   name='save_snapshot'),
    path('snapshots/<int:file_id>/',          views.get_snapshots,      name='get_snapshots'),
    path('snapshots/<int:snapshot_id>/load/', views.load_snapshot,      name='load_snapshot'),
    path('upload-map/',                       views.upload_map,          name='upload_map'),
    path('analyze-ocad/',                     views.analyze_ocad,        name='analyze_ocad'),
    path('import-courses/',                   views.import_courses,      name='import_courses'),
    path('files/<int:file_id>/label/',        views.assign_label,        name='assign_label'),
    path('labels/create/',                    views.create_label,        name='create_label'),
    path('labels/<int:label_id>/delete/',     views.delete_label,        name='delete_label'),
    path('labels/<int:label_id>/color/',      views.update_label_color,  name='update_label_color'),
    path('delete/<int:file_id>/',    views.delete_project_file,  name='delete_project_file'),
    path('settings/',                views.get_editor_settings,  name='get_editor_settings'),
    path('settings/toggle/',         views.toggle_editor_setting, name='toggle_editor_setting'),
    path('checkin/',                 views.checkin,        name='checkin'),
    path('debug/sync-has-mask/', views.sync_has_mask, name='sync_has_mask'),
]
