from django.contrib import admin
from django.urls import path, include

from django.conf import settings
from django.conf.urls.static import static

from django.contrib.auth import views as auth_views
from django.contrib.auth.decorators import login_not_required
from CQCPathfinder.forms import StyledLoginForm, StyledPasswordChangeForm
from django.views.generic import RedirectView

from main import views
from account import views as account_views
from CQCPathfinder import internal_views

urlpatterns = [
    path('editor/', include('project.urls')),
    path('account/', include('account.urls')),

    path("admin/", admin.site.urls),
    path("internal/sync-volume-to-r2/", internal_views.trigger_volume_sync, name="trigger_volume_sync"),
    path("", include("main.urls")),
    path('coursesetter/', include('coursesetter.urls')),
    path('play-old/', include('play.urls')),
    path('play/', include('results.play_urls')),
    path('results/', include('results.results_urls')),
    path('stats/', include('results.stats_urls')),

    # Forum
    path('forum/',                           account_views.forum_index,        name='forum'),
    path('forum/thread/<int:pk>/',           account_views.forum_thread,       name='forum_thread'),
    path('forum/thread/<int:pk>/vote/',      account_views.forum_thread_vote,  name='forum_thread_vote'),
    path('forum/thread/<int:pk>/edit/',      account_views.forum_thread_edit,  name='forum_thread_edit'),
    path('forum/comment/<int:pk>/vote/',     account_views.forum_comment_vote, name='forum_comment_vote'),
    path('forum/comment/<int:pk>/edit/',     account_views.forum_comment_edit, name='forum_comment_edit'),

    # login/logout — login page must stay public (else the redirect-to-login
    # would loop forever).
    path('login/', login_not_required(
        auth_views.LoginView.as_view(authentication_form=StyledLoginForm)
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
