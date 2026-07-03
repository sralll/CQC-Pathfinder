from django.conf import settings
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render
from django.http import JsonResponse, HttpResponseForbidden
from django.views.decorators.http import require_POST
from django.views.i18n import set_language as django_set_language
from django.db.models import Count
from django.utils import timezone
from django.utils.translation import gettext as _
from .models import Profile, Team, ForumThread, ForumComment


@login_required
def set_language(request):
    """Language switcher endpoint.

    Delegates to Django's built-in set_language (validates the language, sets the
    cookie, redirects to ?next). On top of that, for an authenticated user it
    persists the choice to Profile.language so the preference follows the account
    across devices. Profile.language is the durable source of truth, the cookie
    is the per-browser runtime state.
    """
    response = django_set_language(request)
    if request.method == 'POST' and request.user.is_authenticated:
        lang = request.POST.get('language')
        if lang in dict(settings.LANGUAGES):
            Profile.objects.filter(user=request.user).update(language=lang)
    return response

@login_required
def switch_team(request, team_id):
    team = get_object_or_404(Team, id=team_id)
    profile = request.user.profile
    if profile.teams.filter(id=team_id).exists():
        profile.active_team = team
        profile.save()
    return redirect(request.META.get('HTTP_REFERER', '/'))


# ──────────────────────────────────────────────────────────────────────────
#  Forum
# ──────────────────────────────────────────────────────────────────────────

@login_required
def forum_index(request):
    """List of threads with search + sort. POST creates a new thread."""
    if request.method == "POST":
        title = (request.POST.get('title') or '').strip()
        body = (request.POST.get('body') or '').strip()
        if title and body:
            thread = ForumThread.objects.create(
                author=request.user,
                title=title[:160],
                body=body[:4000],
            )
            return redirect('forum_thread', pk=thread.pk)
        # invalid submit → fall through and re-render the list with the form open
        form_error = _("Title and text must not be empty.")
    else:
        form_error = None

    # Search is performed client-side on the loaded threads (see forum.js).
    sort = request.GET.get('sort', 'new')

    threads = (
        ForumThread.objects
        .select_related('author')
        .annotate(n_comments=Count('comments', distinct=True),
                  n_upvotes=Count('upvotes', distinct=True))
    )

    if sort == 'top':
        threads = threads.order_by('-n_upvotes', '-created_at')
    else:
        sort = 'new'
        threads = threads.order_by('-created_at')

    voted_thread_ids = set(request.user.upvoted_threads.values_list('id', flat=True))

    return render(request, 'forum/index.html', {
        'threads': threads,
        'sort': sort,
        'voted_thread_ids': voted_thread_ids,
        'form_error': form_error,
        'open_form': bool(form_error),
    })


@login_required
def forum_thread(request, pk):
    """Single thread with its comments. POST adds a comment."""
    thread = get_object_or_404(
        ForumThread.objects.select_related('author').annotate(n_upvotes=Count('upvotes', distinct=True)),
        pk=pk,
    )

    if request.method == "POST":
        body = (request.POST.get('body') or '').strip()
        if body:
            ForumComment.objects.create(thread=thread, author=request.user, body=body[:4000])
        return redirect('forum_thread', pk=pk)

    comments = (
        thread.comments
        .select_related('author')
        .annotate(n_upvotes=Count('upvotes', distinct=True))
    )

    return render(request, 'forum/thread.html', {
        'thread': thread,
        'comments': comments,
        'n_upvotes': thread.n_upvotes,
        'n_comments': comments.count(),
        'thread_voted': thread.upvotes.filter(pk=request.user.pk).exists(),
        'voted_comment_ids': set(request.user.upvoted_comments.values_list('id', flat=True)),
    })


@login_required
@require_POST
def forum_thread_vote(request, pk):
    """Toggle the current user's upvote on a thread."""
    thread = get_object_or_404(ForumThread, pk=pk)
    if thread.upvotes.filter(pk=request.user.pk).exists():
        thread.upvotes.remove(request.user)
        voted = False
    else:
        thread.upvotes.add(request.user)
        voted = True
    return JsonResponse({'voted': voted, 'count': thread.upvotes.count()})


@login_required
@require_POST
def forum_comment_vote(request, pk):
    """Toggle the current user's upvote on a comment."""
    comment = get_object_or_404(ForumComment, pk=pk)
    if comment.upvotes.filter(pk=request.user.pk).exists():
        comment.upvotes.remove(request.user)
        voted = False
    else:
        comment.upvotes.add(request.user)
        voted = True
    return JsonResponse({'voted': voted, 'count': comment.upvotes.count()})


@login_required
@require_POST
def forum_thread_edit(request, pk):
    """Edit a thread — only the author may do so."""
    thread = get_object_or_404(ForumThread, pk=pk)
    if thread.author_id != request.user.id:
        return HttpResponseForbidden(_("You can only edit your own topics."))
    title = (request.POST.get('title') or '').strip()
    body = (request.POST.get('body') or '').strip()
    if title and body:
        thread.title = title[:160]
        thread.body = body[:4000]
        thread.edited_at = timezone.now()
        thread.save()
    return redirect('forum_thread', pk=pk)


@login_required
@require_POST
def forum_comment_edit(request, pk):
    """Edit a comment — only the author may do so."""
    comment = get_object_or_404(ForumComment, pk=pk)
    if comment.author_id != request.user.id:
        return HttpResponseForbidden(_("You can only edit your own replies."))
    body = (request.POST.get('body') or '').strip()
    if body:
        comment.body = body[:4000]
        comment.edited_at = timezone.now()
        comment.save()
    return redirect('forum_thread', pk=comment.thread_id)
