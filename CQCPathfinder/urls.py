from django.conf import settings
from django.contrib import admin
from django.urls import path, include

from django.contrib.auth import views as auth_views
from django.contrib.auth.decorators import login_not_required
from CQCPathfinder.forms import StyledPasswordChangeForm
from django.views.generic import RedirectView
from django.views.i18n import JavaScriptCatalog
from account.views import set_language

from CQCPathfinder import views
from CQCPathfinder import internal_views
from results import debug_views

urlpatterns = [
    path('editor/', include('project.urls')),
    path('account/', include('account.urls')),

    path("admin/", admin.site.urls),

    # i18n endpoints are covered by LoginRequiredMiddleware. The login page uses
    # server-rendered translations and does not need the JS catalog.
    path("i18n/setlang/", set_language, name="set_language"),
    path("jsi18n/", JavaScriptCatalog.as_view(), name="javascript-catalog"),

    path("internal/sync-volume-to-r2/", internal_views.trigger_volume_sync, name="trigger_volume_sync"),
    path("", views.home_view, name="home"),
    path("guide/", views.guide_view, name="guide"),
    path("feedback/", views.feedback_view, name="feedback"),
    path('play/', include('results.play_urls')),
    path('results/', include('results.results_urls')),
    path('stats/', include('results.stats_urls')),
    path('forum/', include('account.forum_urls')),
    path('debug/infinity/', debug_views.debug_infinity, name='debug_infinity'),
    path('debug/infinity/api/reports/', debug_views.debug_infinity_reports, name='debug_infinity_reports'),
    path('debug/infinity/api/reports/<int:report_id>/', debug_views.debug_infinity_report_detail, name='debug_infinity_report_detail'),
    path('debug/infinity/api/files/<int:file_id>/map/', debug_views.debug_infinity_file_map, name='debug_infinity_file_map'),
    path('debug/infinity/api/files/<int:file_id>/mask/', debug_views.debug_infinity_file_mask, name='debug_infinity_file_mask'),
    path('debug/user-routes/', debug_views.debug_user_routes, name='debug_user_routes'),
    path('debug/user-routes/api/files/', debug_views.debug_user_route_files, name='debug_user_route_files'),
    path('debug/user-routes/api/files/<int:file_id>/map/', debug_views.debug_user_route_file_map, name='debug_user_route_file_map'),
    path('debug/user-routes/api/files/<int:file_id>/mask/', debug_views.debug_user_route_file_mask, name='debug_user_route_file_mask'),
    path('debug/user-routes/api/files/<int:file_id>/navgraph/', debug_views.debug_user_route_file_navgraph, name='debug_user_route_file_navgraph'),
    path('debug/user-routes/api/files/<int:file_id>/passages/', debug_views.debug_user_route_file_passages, name='debug_user_route_file_passages'),

    # Login must stay public, otherwise redirect-to-login would loop forever.
    path('login/', login_not_required(
        views.LocaleLoginView.as_view()
    ), name='login'),
    path('logout/', views.logout_view, name='logout'),

    # password change (when logged in)
    path('password_change/', auth_views.PasswordChangeView.as_view(
        form_class=StyledPasswordChangeForm,
        template_name='registration/password_change_form.html',
        success_url='/',
    ), name='password_change'),

    path('favicon.ico', RedirectView.as_view(url='/static/favicon.ico', permanent=True)),
]

# DEBUG-only: one-request agent login (see AGENTS.md). Registered conditionally
# so the route does not exist at all on deployed instances (DEBUG=False).
if settings.DEBUG:
    urlpatterns.append(
        path('dev/agent-login/', login_not_required(views.dev_agent_login), name='dev_agent_login')
    )
