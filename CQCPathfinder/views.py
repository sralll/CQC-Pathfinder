from django.conf import settings
from django.contrib.auth import logout
from django.contrib.auth.decorators import login_required
from django.contrib.auth.views import LoginView
from django.core.cache import cache
from django.shortcuts import redirect, render
from django.utils import translation
from django.views.decorators.http import require_POST

from CQCPathfinder.forms import StyledLoginForm


def _client_ip(request):
    forwarded_for = request.META.get("HTTP_X_FORWARDED_FOR", "")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "unknown")


def _login_rate_key(request):
    username = (request.POST.get("username") or "").strip().lower()[:150]
    return f"login-fail:{_client_ip(request)}:{username or '-'}"


class LocaleLoginView(LoginView):
    """Login view that re-applies the user's persistent language preference.

    Profile.language is the durable source of truth; on successful login we copy
    it onto the language cookie so the preference takes effect immediately and on
    every subsequent request in this browser. Blank preference → leave the cookie
    untouched (fall back to existing cookie / Accept-Language / LANGUAGE_CODE).
    """
    authentication_form = StyledLoginForm

    def dispatch(self, request, *args, **kwargs):
        if request.method == "POST":
            key = _login_rate_key(request)
            if cache.get(key, 0) >= settings.LOGIN_RATE_LIMIT_ATTEMPTS:
                form = self.get_form()
                form.add_error(None, "Too many login attempts. Please try again later.")
                return self.render_to_response(self.get_context_data(form=form), status=429)
        return super().dispatch(request, *args, **kwargs)

    def form_invalid(self, form):
        key = _login_rate_key(self.request)
        timeout = settings.LOGIN_RATE_LIMIT_WINDOW
        if not cache.add(key, 1, timeout=timeout):
            try:
                cache.incr(key)
            except ValueError:
                cache.set(key, 1, timeout=timeout)
        return super().form_invalid(form)

    def form_valid(self, form):
        cache.delete(_login_rate_key(self.request))
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


@login_required
@require_POST
def logout_view(request):
    logout(request)
    return redirect('login')
