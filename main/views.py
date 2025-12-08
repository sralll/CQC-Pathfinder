from django.shortcuts import render
from django.contrib.auth.decorators import login_required
import math
from django.http import JsonResponse, HttpResponseNotFound
from django.contrib.auth.models import User
from django.db.models import Count
from play.models import UserResult
from django.shortcuts import get_object_or_404
from coursesetter.models import publishedFile
from accounts.models import UserProfile
from django.views.decorators.http import require_GET

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

@login_required
def get_published_files(request):
    user = request.user
    result = []

    try:
        # Get user's kader
        try:
            user_kader = user.userprofile.kader
        except UserProfile.DoesNotExist:
            user_kader = None

        # Only include published files in the user's kader
        published_entries = publishedFile.objects.filter(published=True, kader=user_kader)

        for entry in published_entries:
            result.append({
                'filename': entry.filename,
                'modified': entry.last_edited.timestamp() if entry.last_edited else 0
            })

        # Sort by modified time (descending)
        result.sort(key=lambda x: x['modified'], reverse=True)

        # Return just the filenames
        return JsonResponse([r['filename'] for r in result], safe=False)

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@login_required
def users_with_results(request):
    try:
        # Get logged-in user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            user_kader = None

        # Get distinct user IDs that have results
        user_ids = UserResult.objects.values_list('user_id', flat=True).distinct()

        # Filter users by those IDs and matching kader
        users = User.objects.filter(id__in=user_ids)
        if user_kader:
            users = users.filter(userprofile__kader=user_kader)

        user_list = [
            {
                'id': u.id,
                'name': u.get_full_name() or u.username  # fallback to username
            }
            for u in users
        ]
        return JsonResponse({'users': user_list})

    except Exception as e:
        return JsonResponse({'error': str(e)}, status=500)

@login_required
def fetch_plot_data(request, filename):
    try:
        from accounts.models import UserProfile

        # 0. Resolve user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            return JsonResponse({"error": "User has no kader"}, status=404)

        unique_filename = f"{filename}_{user_kader.name}"

        # 1. Load control points safely by unique_filename
        try:
            entry = publishedFile.objects.get(
                unique_filename=unique_filename,
                published=True
            )
        except publishedFile.DoesNotExist:
            return JsonResponse({"error": "File not found"}, status=404)

        cP_list = entry.data.get('cP', []) if entry.data else []

        cumulative_distance = 0.0
        distances = []

        for pair in cP_list:
            sx, sy = pair['start']['x'], pair['start']['y']
            zx, zy = pair['ziel']['x'], pair['ziel']['y']
            dx = zx - sx
            dy = zy - sy
            cumulative_distance += math.sqrt(dx**2 + dy**2)
            distances.append(round(cumulative_distance, 2))

        ncP_max = len(distances)

        # 2. Users with exactly ncP_max entries (public filename!)
        matching_users = (
            UserResult.objects
            .filter(filename=filename)
            .values('user_id')
            .annotate(count=Count('id'))
            .filter(count=ncP_max)
        )

        user_ids = [u['user_id'] for u in matching_users]

        # 3. Load and validate user data
        all_user_data = []
        users = User.objects.in_bulk(user_ids)

        for user_id in user_ids:
            entries = UserResult.objects.filter(
                filename=filename,
                user_id=user_id
            )

            if entries.filter(competition=False).exists():
                continue

            entries = entries.order_by('control_pair_index')

            all_user_data.append({
                'user_id': user_id,
                'full_name': users[user_id].get_full_name() or f"User_{user_id}",
                'controls': [
                    {
                        'index': e.control_pair_index,
                        'choice_time': e.choice_time,
                        'selected_route': e.selected_route,
                        'selected_route_runtime': e.selected_route_runtime,
                        'shortest_route_runtime': e.shortest_route_runtime
                    }
                    for e in entries
                ]
            })

        # 4. Summary statistics
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

        # 5. Fastest averages per control
        fastest_times = []
        for idx in range(ncP_max):
            times = []
            for u in all_user_data:
                c = u['controls'][idx]
                total_time = (
                    (c['choice_time'] or 0)
                    + ((c['selected_route_runtime'] or 0) - (c['shortest_route_runtime'] or 0))
                )
                times.append(total_time)

            times.sort()
            fastest = times[:3]
            avg = sum(fastest) / len(fastest) if fastest else 0

            fastest_times.append({
                'ncP': idx,
                'average_fastest_time': round(avg, 2)
            })

        # 6. Response
        return JsonResponse({
            'distances': distances,
            'results': all_user_data,
            'shortest_route_runtime': [
                c['shortest_route_runtime']
                for c in all_user_data[0]['controls']
            ] if all_user_data else [],
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

    # annotate rel_error
    qs = UserResult.objects.filter(
        user__userprofile__kader=kader,
        competition=True
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

    # --- Aggregate for all athletes together ---
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

    # --- First row: all athletes ---
    data.append({
        "athlete": "Kaderdurchschnitt",
        "posten": total["posten"],
        "avg_choice_time": round(total["avg_choice_time"], 2) if total["avg_choice_time"] else None,
        "avg_error": round(total["avg_error"], 2) if total["avg_error"] else None,
        "schnellste": round(total["schnellste"] / total["posten"] * 100, 1) if total["posten"] else 0,
        "lt5": round(total["lt5"] / total["posten"] * 100, 1) if total["posten"] else 0,
        "lt10": round(total["lt10"] / total["posten"] * 100, 1) if total["posten"] else 0,
        "gt10": round(total["gt10"] / total["posten"] * 100, 1) if total["posten"] else 0,
    })

    # --- Then add individual athletes ---
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
        # get user's kader
        try:
            user_kader = request.user.userprofile.kader
        except UserProfile.DoesNotExist:
            return HttpResponseNotFound("User has no kader assigned")

        unique_filename = f"{filename}_{user_kader.name}"

        gamefile = publishedFile.objects.get(unique_filename=unique_filename)
        data = gamefile.data or {}

        file_base = filename.replace('.json', '')

        cp_count = len(data.get('cP', []))

        existing_entries = list(
            UserResult.objects.filter(
                user=request.user,
                filename=file_base
            ).values_list('control_pair_index', flat=True)
        )

        missing_cps = [i for i in range(cp_count) if i not in existing_entries]

        return JsonResponse({
            'data': data,
            'missingCPs': missing_cps
        })

    except publishedFile.DoesNotExist:
        return HttpResponseNotFound("File not found for this kader")

    except Exception as e:
        return JsonResponse(
            {'message': 'Error loading file', 'error': str(e)},
            status=500
        )