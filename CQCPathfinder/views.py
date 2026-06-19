from django.conf import settings
from django.contrib.auth import logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import LoginView
from django.shortcuts import redirect, render
from django.utils import translation

from CQCPathfinder.forms import StyledLoginForm


class LocaleLoginView(LoginView):
    """Login view that re-applies the user's persistent language preference.

    Profile.language is the durable source of truth; on successful login we copy
    it onto the language cookie so the preference takes effect immediately and on
    every subsequent request in this browser. Blank preference → leave the cookie
    untouched (fall back to existing cookie / Accept-Language / LANGUAGE_CODE).
    """
    authentication_form = StyledLoginForm

    def form_valid(self, form):
        response = super().form_valid(form)
        try:
            lang = self.request.user.profile.language
        except Exception:
            lang = ''
        if lang and lang in dict(settings.LANGUAGES):
            translation.activate(lang)
            response.set_cookie(
                settings.LANGUAGE_COOKIE_NAME, lang,
                max_age=settings.LANGUAGE_COOKIE_AGE,
                path=settings.LANGUAGE_COOKIE_PATH,
                domain=settings.LANGUAGE_COOKIE_DOMAIN,
                secure=settings.LANGUAGE_COOKIE_SECURE,
                httponly=settings.LANGUAGE_COOKIE_HTTPONLY,
                samesite=settings.LANGUAGE_COOKIE_SAMESITE,
            )
        return response


@login_required
def home_view(request):
    is_trainer = request.user.groups.filter(name='Trainer').exists()
    return render(request, 'home.html', {'is_trainer': is_trainer})


@login_required
def guide_view(request):
    return render(request, 'guide.html')


@login_required
def feedback_view(request):
    return redirect('forum')


def logout_view(request):
    logout(request)
    return redirect('login')
