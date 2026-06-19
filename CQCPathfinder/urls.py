from django.contrib import admin
from django.urls import path, include

from django.conf import settings
from django.conf.urls.static import static

from django.contrib.auth import views as auth_views
from django.contrib.auth.decorators import login_not_required
from CQCPathfinder.forms import StyledPasswordChangeForm
from django.views.generic import RedirectView
from django.views.i18n import JavaScriptCatalog
from account.views import set_language

from CQCPathfinder import views
from CQCPathfinder import internal_views

urlpatterns = [
    path('editor/', include('project.urls')),
    path('account/', include('account.urls')),

    path("admin/", admin.site.urls),

    # i18n — language switcher (POST) and the JS gettext catalog. Both are
    # login_not_required so the language can be switched on the public login page
    # (the project enforces login globally via LoginRequiredMiddleware).
    path("i18n/setlang/", set_language, name="set_language"),
    path("jsi18n/", login_not_required(JavaScriptCatalog.as_view()), name="javascript-catalog"),

    path("internal/sync-volume-to-r2/", internal_views.trigger_volume_sync, name="trigger_volume_sync"),
    path("", views.home_view, name="home"),
    path("guide/", views.guide_view, name="guide"),
    path("feedback/", views.feedback_view, name="feedback"),
    path('play/', include('results.play_urls')),
    path('results/', include('results.results_urls')),
    path('stats/', include('results.stats_urls')),
    path('forum/', include('account.forum_urls')),

    # login/logout — login page must stay public (else the redirect-to-login
    # would loop forever).
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

    # password reset (via email) — must stay public so a locked-out user who
    # forgot their password can actually get back in.
    path('password_reset/', login_not_required(auth_views.PasswordResetView.as_view()), name='password_reset'),
    path('password_reset/done/', login_not_required(auth_views.PasswordResetDoneView.as_view()), name='password_reset_done'),
    path('reset/<uidb64>/<token>/', login_not_required(auth_views.PasswordResetConfirmView.as_view()), name='password_reset_confirm'),
    path('reset/done/', login_not_required(auth_views.PasswordResetCompleteView.as_view()), name='password_reset_complete'),

    path('favicon.ico', login_not_required(RedirectView.as_view(url='/static/favicon.ico', permanent=True))),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
