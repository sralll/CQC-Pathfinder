from django.shortcuts import render
from django.contrib.auth.decorators import login_required
import math
from django.http import JsonResponse, HttpResponseNotFound
from django.contrib.auth.models import User, Group
from django.db.models import Count
from play.models import UserResult
from django.shortcuts import get_object_or_404
from coursesetter.models import publishedFile
from accounts.models import UserProfile
from django.views.decorators.http import require_GET
from django.db.models import F, Q

from django.contrib.auth import logout

def logout_view(request):
    logout(request)
    return redirect('login') # or wherever you want them to go

@login_required
def home_view(request):
    # Check if the user is in the 'Trainer' group
    is_trainer = request.user.groups.filter(name='Trainer').exists()

    return render(request, 'home.html', {'is_trainer': is_trainer})

@login_required
def results_view(request):

    return render(request, 'results.html')

@login_required
def stats_view(request):
    is_trainer = request.user.groups.filter(name='Trainer').exists()
    return render(request, 'stats.html', {'is_trainer': is_trainer})

def visible_published_files_for_user(user):
    qs = publishedFile.objects.filter(published=True)
    if user.is_superuser:
        return qs

    kader = getattr(user.userprofile, 'kader', None)
    if not kader:
        return qs.none()

    condition = Q(kader=kader)
    if kader.shared_pool:
        condition |= Q(kader__shared_pool=True)

    return qs.filter(condition)

def visible_users_with_results_for_user(user):
    # Get user IDs that have results
    user_ids = UserResult.objects.values_list('user_id', flat=True).distinct()

    qs = User.objects.filter(id__in=user_ids)

    if user.is_superuser:
        return qs

    try:
        user_kader = user.userprofile.kader
    except UserProfile.DoesNotExist:
        return qs.none()

    condition = Q(userprofile__kader=user_kader)

    if user_kader.shared_pool:
        condition |= Q(userprofile__kader__shared_pool=True)

    return qs.filter(condition)

@require_GET
@login_required
def get_published_files(request):
    user = request.user
    result = []

    try:
        user_kader = getattr(user.userprofile, "kader", None)
        user_kader_name = user_kader.name if user_kader else ""
        user_shared_pool = user_kader.shared_pool if user_kader else False

        qs = visible_published_files_for_user(user)

        for entry in qs:
            result.append({
                'filename': entry.filename,
                'modified': entry.last_edited.timestamp() if entry.last_edited else 0,
                'kader': entry.kader.name if entry.kader else "",
            })

        # Sort by user's kader match first, then date descending
        result.sort(
            key=lambda x: (
                0 if x['kader'] == user_kader_name else 1,  # own kader first
                -x['modified']                              # then newest first
            )
        )

        return JsonResponse({
            'files': result,
            'user_shared_pool': user_shared_pool
        }, safe=False)

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@login_required
def users_with_results(request):
    try:
        users = visible_users_with_results_for_user(request.user)

        user_list = [
            {
                'id': u.id,
                'name': u.get_full_name() or u.username
            }
            for u in users
        ]

        return JsonResponse({'users': user_list})

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@login_required
def fetch_plot_data(request, filename):
    try:
        # Get user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            return HttpResponseNotFound("User has no kader assigned")

        # Build queryset of files user is allowed to see
        qs = publishedFile.objects.filter(published=True, filename=filename)

        if not request.user.is_superuser:
            condition = Q(kader=user_kader)
            if user_kader.shared_pool:
                condition |= Q(kader__shared_pool=True)
            qs = qs.filter(condition)

        # Prefer user's own kader file
        file_obj = qs.filter(kader=user_kader).first() or qs.first()
        if not file_obj:
            return JsonResponse({"error": "File not accessible"}, status=404)

        # Load control points safely
        cP_list = file_obj.data.get('cP', []) if file_obj.data else []
        cumulative_distance = 0.0
        distances = []
        for pair in cP_list:
            sx, sy = pair['start']['x'], pair['start']['y']
            zx, zy = pair['ziel']['x'], pair['ziel']['y']
            dx, dy = zx - sx, zy - sy
            cumulative_distance += math.sqrt(dx**2 + dy**2)
            distances.append(round(cumulative_distance, 2))

        ncP_max = len(distances)

        # Users with exactly ncP_max entries
        base_qs = UserResult.objects.filter(filename=filename)

        matching_users_qs = (
            base_qs
            .values('user_id')
            .annotate(count=Count('id'))
            .filter(count=ncP_max)
        )

        # Exclude Trainer users if requester is not a trainer
        if not request.user.groups.filter(name='Trainer').exists():
            matching_users_qs = matching_users_qs.exclude(user__groups__name='Trainer')

        user_ids = [u['user_id'] for u in matching_users_qs]
        users = User.objects.in_bulk(user_ids)

        # Load user data
        all_user_data = []

        for user_id in user_ids:
            entries = UserResult.objects.filter(
                filename=filename,
                user_id=user_id
            ).order_by('control_pair_index')

            all_user_data.append({
                'user_id': user_id,
                'full_name': users[user_id].get_full_name() or f"User_{user_id}",
                'controls': [
                    {
                        'index': e.control_pair_index,
                        'choice_time': e.choice_time,
                        'selected_route': e.selected_route,
                        'selected_route_runtime': e.selected_route_runtime,
                        'shortest_route_runtime': e.shortest_route_runtime,
                        'competition': e.competition,  # ✅ important
                    }
                    for e in entries
                ]
            })

        # Summary ranking
        table_ranking = []
        for u in all_user_data:
            controls = u['controls']
            total_choice_time = sum(c['choice_time'] or 0 for c in controls)
            total_diff_runtime = sum(
                abs((c['selected_route_runtime'] or 0) - (c['shortest_route_runtime'] or 0))
                for c in controls
            )
            table_ranking.append({
                'user_id': u['user_id'],
                'full_name': u['full_name'],
                'total_choice_time': total_choice_time,
                'total_diff_runtime': total_diff_runtime,
                'total_sum': total_choice_time + total_diff_runtime
            })
        table_ranking.sort(key=lambda x: x['total_sum'])

        # Fastest averages per control
        fastest_times = []
        for idx in range(ncP_max):
            times = []
            for u in all_user_data:
                c = u['controls'][idx]
                # Only include competition runs
                if c.get('competition', True):
                    total_time = (c['choice_time'] or 0) + ((c['selected_route_runtime'] or 0) - (c['shortest_route_runtime'] or 0))
                    times.append(total_time)

            times.sort()
            fastest = times[:3]  # top 3 fastest
            avg = sum(fastest)/len(fastest) if fastest else 0
            fastest_times.append({'ncP': idx, 'average_fastest_time': round(avg, 2)})

        # Return response
        return JsonResponse({
            'distances': distances,
            'results': all_user_data,
            'shortest_route_runtime': [c['shortest_route_runtime'] for c in all_user_data[0]['controls']] if all_user_data else [],
            'tableData': table_ranking,
            'avg_times': fastest_times,
        })

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)
 
@login_required
def user_game_stats(request, user_id=None):
    # Check if the logged-in user is an admin
    user = request.user
    if not user_id: 
        target_user = user
    else:
        target_user = get_object_or_404(User, id=user_id)

    # Query the target user's results
    results_user = UserResult.objects.filter(user_id=target_user.id, competition=True)
    user_entries = results_user.count()

    # Initialize stats counters
    fastest_user = 0
    less_5_user = 0
    between_5_10_user = 0
    more_10_user = 0

    total_runtime_diff_user = 0
    total_choice_time_user = 0

    for res in results_user:
        if res.shortest_route_runtime == 0:
            continue  # avoid division by zero

        runtime_diff = res.selected_route_runtime - res.shortest_route_runtime
        pct_diff = runtime_diff / res.shortest_route_runtime

        total_runtime_diff_user += runtime_diff
        total_choice_time_user += res.choice_time

        if runtime_diff <= 0:
            fastest_user += 1
        elif pct_diff < 0.05:
            less_5_user += 1
        elif pct_diff < 0.10:
            between_5_10_user += 1
        else:
            more_10_user += 1

    total = fastest_user + less_5_user + between_5_10_user + more_10_user

    # Get global results (stats for all users)
    results_global = UserResult.objects.filter(competition=True)

    # Exclude users in the "Trainer" group
    results_global = results_global.exclude(user__groups__name='Trainer')

    global_entries = results_global.count()

    fastest_global = 0
    less_5_global = 0
    between_5_10_global = 0
    more_10_global = 0

    total_runtime_diff_global = 0
    total_choice_time_global = 0

    for res in results_global:
        if res.shortest_route_runtime == 0:
            continue  # avoid division by zero

        runtime_diff = res.selected_route_runtime - res.shortest_route_runtime
        pct_diff = runtime_diff / res.shortest_route_runtime

        total_runtime_diff_global += runtime_diff
        total_choice_time_global += res.choice_time

        if runtime_diff <= 0:
            fastest_global += 1
        elif pct_diff < 0.05:
            less_5_global += 1
        elif pct_diff < 0.10:
            between_5_10_global += 1
        else:
            more_10_global += 1

    total_global = fastest_global + less_5_global + between_5_10_global + more_10_global

    # Calculate percentages
    fastest_global = fastest_global / global_entries * 100 if global_entries else 0
    less_5_global = less_5_global / global_entries * 100 if global_entries else 0
    between_5_10_global = between_5_10_global / global_entries * 100 if global_entries else 0
    more_10_global = more_10_global / global_entries * 100 if global_entries else 0

    fastest_user = fastest_user / user_entries * 100 if user_entries else 0
    less_5_user = less_5_user / user_entries * 100 if user_entries else 0
    between_5_10_user = between_5_10_user / user_entries * 100 if user_entries else 0
    more_10_user = more_10_user / user_entries * 100 if user_entries else 0

    # Prepare the stats dictionary
    stats = {
        'total_entries': user_entries,
        'category_counts': {
            'fastest': fastest_user,
            'less_5': less_5_user,
            'between_5_10': between_5_10_user,
            'more_10': more_10_user
        },
        'avg_runtime_diff': total_runtime_diff_user / total if total else 0,
        'avg_choice_time': total_choice_time_user / total if total else 0,
        'global_entries': global_entries,
        'global_category_counts': {
            'fastest': fastest_global,
            'less_5': less_5_global,
            'between_5_10': between_5_10_global,
            'more_10': more_10_global
        },
        'global_avg_runtime_diff': total_runtime_diff_global / total_global if total_global else 0,
        'global_avg_choice_time': total_choice_time_global / total_global if total_global else 0
    }

    return JsonResponse(stats)

from .forms import FeedbackForm
from django.shortcuts import redirect

@login_required
def feedback_view(request):
    if request.method == "POST":
        form = FeedbackForm(request.POST)
        if form.is_valid():
            form.save()
            # Redirect to same page or a thank-you page
            return redirect('feedback')  # name of your url pattern
    else:
        form = FeedbackForm()

    return render(request, "feedback.html", {"form": form})


from django.http import JsonResponse
from django.db.models import (
    Avg, Count, F, Q, FloatField,
    Case, When, ExpressionWrapper
)

@login_required
def trainer_stats(request):
    try:
        profile = request.user.userprofile
    except UserProfile.DoesNotExist:
        return JsonResponse({"error": "User has no profile"}, status=404)

    kader = profile.kader

    # --- NEW: read mode ---
    mode = request.GET.get("mode", "competition")
    is_competition = (mode == "competition")

    # --- base queryset ---
    qs = UserResult.objects.filter(
        user__userprofile__kader=kader,
        competition=is_competition   # <-- SWITCH HERE
    ).exclude(
        user__groups__name="Trainer"
    ).annotate(
        rel_error=ExpressionWrapper(
            (F("selected_route_runtime") - F("shortest_route_runtime")) / F("shortest_route_runtime"),
            output_field=FloatField()
        )
    )

    # --- Aggregate per athlete ---
    athlete_qs = qs.values(
        "user__id",
        "user__first_name",
        "user__last_name",
    ).annotate(
        posten=Count("id"),
        avg_choice_time=Avg("choice_time"),
        avg_error=Avg(F("selected_route_runtime") - F("shortest_route_runtime")),
        schnellste=Count(Case(When(selected_route_runtime=F("shortest_route_runtime"), then=1))),
        lt5=Count(Case(When(Q(rel_error__gt=0) & Q(rel_error__lt=0.05), then=1))),
        lt10=Count(Case(When(rel_error__gte=0.05, rel_error__lt=0.10, then=1))),
        gt10=Count(Case(When(rel_error__gte=0.10, then=1))),
    ).order_by("user__last_name")

    # --- Aggregate total ---
    total = qs.aggregate(
        posten=Count("id"),
        avg_choice_time=Avg("choice_time"),
        avg_error=Avg(F("selected_route_runtime") - F("shortest_route_runtime")),
        schnellste=Count(Case(When(selected_route_runtime=F("shortest_route_runtime"), then=1))),
        lt5=Count(Case(When(Q(rel_error__gt=0) & Q(rel_error__lt=0.05), then=1))),
        lt10=Count(Case(When(rel_error__gte=0.05, rel_error__lt=0.10, then=1))),
        gt10=Count(Case(When(rel_error__gte=0.10, then=1))),
    )

    data = []

    # --- label depending on mode ---
    label = "Kaderdurchschnitt (Wettkampf)" if is_competition else "Kaderdurchschnitt (Training)"

    data.append({
        "athlete": label,
        "posten": total["posten"],
        "avg_choice_time": round(total["avg_choice_time"], 2) if total["avg_choice_time"] else None,
        "avg_error": round(total["avg_error"], 2) if total["avg_error"] else None,
        "schnellste": round(total["schnellste"] / total["posten"] * 100, 1) if total["posten"] else 0,
        "lt5": round(total["lt5"] / total["posten"] * 100, 1) if total["posten"] else 0,
        "lt10": round(total["lt10"] / total["posten"] * 100, 1) if total["posten"] else 0,
        "gt10": round(total["gt10"] / total["posten"] * 100, 1) if total["posten"] else 0,
    })

    for row in athlete_qs:
        data.append({
            "athlete": f"{row['user__first_name']} {row['user__last_name']}",
            "posten": row["posten"],
            "avg_choice_time": round(row["avg_choice_time"], 2) if row["avg_choice_time"] else None,
            "avg_error": round(row["avg_error"], 2) if row["avg_error"] else None,
            "schnellste": round(row["schnellste"] / row["posten"] * 100, 1) if row["posten"] else 0,
            "lt5": round(row["lt5"] / row["posten"] * 100, 1) if row["posten"] else 0,
            "lt10": round(row["lt10"] / row["posten"] * 100, 1) if row["posten"] else 0,
            "gt10": round(row["gt10"] / row["posten"] * 100, 1) if row["posten"] else 0,
        })

    return JsonResponse(data, safe=False)

@login_required
def load_file(request, filename):
    try:
        # Get user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            return HttpResponseNotFound("User has no kader assigned")

        # Base queryset
        qs = publishedFile.objects.filter(published=True, filename=filename)

        # Access rules
        if not request.user.is_superuser:
            condition = Q(kader=user_kader)
            if user_kader.shared_pool:
                condition |= Q(kader__shared_pool=True)
            qs = qs.filter(condition)

        # Prefer file from user's own kader
        gamefile = qs.filter(kader=user_kader).first() or qs.first()

        if not gamefile:
            return HttpResponseNotFound("File not accessible")

        # ✅ Load data FIRST
        data = gamefile.data or {}

        # ✅ Now ncP_max exists
        ncP_max = len(data.get('cP', []))

        # ✅ Correct filename key
        file_base = gamefile.filename.replace('.json', '')

        # --- BLOCK users without full result set (except Trainer) ---
        is_trainer = request.user.groups.filter(name="Trainer").exists()

        if not is_trainer:
            user_entry_count = UserResult.objects.filter(
                user=request.user,
                filename=file_base
            ).count()

            if user_entry_count < ncP_max:
                return JsonResponse({
                    "distances": [],
                    "results": [],
                    "tableData": [],
                    "avg_times": [],
                    "shortest_route_runtime": [],
                    "incomplete": True,
                })

        # --- Missing CP logic ---
        existing_entries = list(
            UserResult.objects.filter(
                user=request.user,
                filename=file_base
            ).values_list('control_pair_index', flat=True)
        )

        missing_cps = [
            i for i in range(ncP_max)
            if i not in existing_entries
        ]

        return JsonResponse({
            'data': data,
            'missingCPs': missing_cps
        })

    except Exception as e:
        return JsonResponse(
            {'message': 'Error loading file', 'error': str(e)},
            status=500
        )