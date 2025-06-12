from django.contrib import admin
from django.urls import path, include

from django.conf import settings
from django.conf.urls.static import static

from django.contrib.auth import views as auth_views
from CQCPathfinder.forms import StyledLoginForm
from django.views.generic import RedirectView

urlpatterns = [

    path("admin/", admin.site.urls),
    path("", include("main.urls")),
    path('coursesetter/', include('coursesetter.urls')),
    path("pathfinding/", include("pathfinding.urls")),
    path('play/', include('play.urls')),

    # login/logout
    path('login/', auth_views.LoginView.as_view(authentication_form=StyledLoginForm), name='login'),

    # password change (when logged in)
    path('password_change/', auth_views.PasswordChangeView.as_view(), name='password_change'),
    path('password_change/done/', auth_views.PasswordChangeDoneView.as_view(), name='password_change_done'),

    # password reset (via email)
    path('password_reset/', auth_views.PasswordResetView.as_view(), name='password_reset'),
    path('password_reset/done/', auth_views.PasswordResetDoneView.as_view(), name='password_reset_done'),
    path('reset/<uidb64>/<token>/', auth_views.PasswordResetConfirmView.as_view(), name='password_reset_confirm'),
    path('reset/done/', auth_views.PasswordResetCompleteView.as_view(), name='password_reset_complete'),

    path('favicon.ico', RedirectView.as_view(url='/static/favicon.ico', permanent=True)),
] + static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)