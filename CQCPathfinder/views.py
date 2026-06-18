from django.contrib.auth import logout
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render


@login_required
def home_view(request):
    is_trainer = request.user.groups.filter(name='Trainer').exists()
    return render(request, 'home.html', {'is_trainer': is_trainer})


@login_required
def feedback_view(request):
    return redirect('forum')


def logout_view(request):
    logout(request)
    return redirect('login')
