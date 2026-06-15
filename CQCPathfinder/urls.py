from django.contrib import admin
from django.urls import path, include

from django.conf import settings
from django.conf.urls.static import static

from django.contrib.auth import views as auth_views
from django.contrib.auth.decorators import login_not_required
from CQCPathfinder.forms import StyledLoginForm, StyledPasswordChangeForm
from django.views.generic import RedirectView

from main import views
from results import views as results_views
from account import views as account_views
from CQCPathfinder import internal_views

urlpatterns = [
    path('editor/', include('project.urls')),
    path('account/', include('account.urls')),

    path("admin/", admin.site.urls),
    path("internal/sync-volume-to-r2/", internal_views.trigger_volume_sync, name="trigger_volume_sync"),
    path("", include("main.urls")),
    path('coursesetter/', include('coursesetter.urls')),
    path("pathfinding/", include("pathfinding.urls")),

    # Play
    path('play/',                            results_views.index,              name='results_home'),
    path('play/infinity/',                   results_views.random_play,        name='infinity_play'),
    path('play/infinity/submit-choice/',     results_views.submit_random_choice, name='submit_infinity_choice'),
    path('play/tutorial/',                   results_views.play_tutorial,      name='play_tutorial'),
    path('play/tutorial-complete/',          results_views.tutorial_complete,  name='play_tutorial_complete'),
    path('play/<int:file_id>/<str:mode>/',   results_views.play,               name='play'),
    path('play/get-files/',                  results_views.get_files,          name='play_get_files'),
    path('play/get-file/<int:file_id>/',     results_views.get_file,           name='play_get_file'),
    path('play/get-map/<str:filename>/',     results_views.get_map,            name='play_get_map'),
    path('play/submit-result/',              results_views.submit_result,      name='submit_result'),

    # Results
    path('results/',                         results_views.results_overview,   name='results_overview'),
    path('results/<int:file_id>/',           results_views.file_results,       name='file_results'),
    path('results/get-list/',                results_views.get_files_overview, name='results_get_list'),
    path('results/<int:file_id>/get-data/',  results_views.get_file_results,   name='results_get_data'),

    # Stats
    path('stats/',                           results_views.stats_view,         name='results_stats'),
    path('stats/get-stats/',                 results_views.get_user_stats,     name='stats_get_stats'),
    path('stats/get-athletes/',              results_views.get_team_athletes,  name='stats_get_athletes'),
    path('stats/get-table/',                 results_views.get_stats_table,    name='stats_get_table'),

    # Forum
    path('forum/',                           account_views.forum_index,        name='forum'),
    path('forum/thread/<int:pk>/',           account_views.forum_thread,       name='forum_thread'),
    path('forum/thread/<int:pk>/vote/',      account_views.forum_thread_vote,  name='forum_thread_vote'),
    path('forum/thread/<int:pk>/edit/',      account_views.forum_thread_edit,  name='forum_thread_edit'),
    path('forum/comment/<int:pk>/vote/',     account_views.forum_comment_vote, name='forum_comment_vote'),
    path('forum/comment/<int:pk>/edit/',     account_views.forum_comment_edit, name='forum_comment_edit'),

    path('play-old/', include('play.urls')),

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