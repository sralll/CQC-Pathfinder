from django.shortcuts import render
from django.contrib.auth.decorators import login_required
import os
import json
import math
from django.http import JsonResponse
from django.conf import settings
from pathlib import Path
from django.contrib.auth.models import User
from django.db.models import Count, Q
from play.models import UserResult
from django.views.decorators.http import require_GET
import numpy as np
from django.shortcuts import get_object_or_404
from collections import defaultdict
from coursesetter.models import publishedFile
from django.core.files.storage import default_storage

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
    result = []

    published_entries = publishedFile.objects.filter(published=True)

    for entry in published_entries:
        filename = entry.filename
        file_path = f"jsonfiles/{filename}"  # S3 prefix

        try:
            # Check if file exists in S3
            if default_storage.exists(file_path):
                modified_time = default_storage.get_modified_time(file_path).timestamp()
                result.append({
                    'filename': filename,
                    'modified': modified_time
                })
        except Exception as e:
            print(f"Error accessing {filename} on S3: {e}")
            continue

    # Sort by modified time (descending)
    result.sort(key=lambda x: x['modified'], reverse=True)

    # Return just the filenames
    return JsonResponse([r['filename'] for r in result], safe=False)

@login_required
def users_with_results(request):
    user_ids = UserResult.objects.values_list('user_id', flat=True).distinct()
    users = User.objects.filter(id__in=user_ids)
    user_list = [
        {
            'id': u.id,
            'name': u.get_full_name() or u.username  # fallback to username if no full name
        }
        for u in users
    ]
    return JsonResponse({'users': user_list})  # Pass the is_trainer flag to the template

@login_required
def fetch_plot_data(request, filename):
    file_path = f"jsonfiles/{filename}.json"

    try:
        # 1. Load control points and compute distances
        with default_storage.open(file_path, 'r') as f:
            content = json.load(f)
            cP_list = content.get('cP', [])
            
            cumulative_distance = 0.0
            distances = []

            for pair in cP_list:
                sx, sy = pair['start']['x'], pair['start']['y']
                zx, zy = pair['ziel']['x'], pair['ziel']['y']
                dx = zx - sx
                dy = zy - sy
                segment_distance = math.sqrt(dx**2 + dy**2)
                cumulative_distance += segment_distance
                distances.append(round(cumulative_distance, 2))  # For JS usage

        ncP_max = len(distances)

        # 2. Get all users with exactly ncP_max entries
        matching_users = (
            UserResult.objects
            .filter(filename=filename)
            .values('user_id')
            .annotate(count=Count('id'))
            .filter(count=ncP_max)
        )

        user_ids = [u['user_id'] for u in matching_users]

        # 3. Load full sorted data for those users
        all_user_data = []
        for user_id in user_ids:
            entries = (
                UserResult.objects
                .filter(filename=filename, user_id=user_id)
                .order_by('control_pair_index')
            )

            user_data = {
                'user_id': user_id,
                'full_name': User.objects.get(id=user_id).get_full_name() or f"User_{user_id}",
                'controls': [
                    {
                        'index': entry.control_pair_index,
                        'choice_time': entry.choice_time,
                        'selected_route_runtime': entry.selected_route_runtime,
                        'shortest_route_runtime': entry.shortest_route_runtime  # Make sure this field exists
                    }
                    for entry in entries
                ]
            }
            all_user_data.append(user_data)

        # 4. Compute and sort summary statistics for each user
        table_ranking = []
        for user_data in all_user_data:
            user_id = user_data['user_id']
            controls = user_data['controls']

            # Check if any fields are None or missing
            total_choice_time = sum(c['choice_time'] or 0 for c in controls)
            total_diff_runtime = sum(
                abs((c['selected_route_runtime'] or 0) - (c.get('shortest_route_runtime') or 0))
                for c in controls
            )

            # Sum of the two values
            total_sum = total_choice_time + total_diff_runtime

            table_ranking.append({
                'user_id': user_id,
                'full_name': User.objects.get(id=user_id).get_full_name() or f"User_{user_id}",
                'total_choice_time': total_choice_time,
                'total_diff_runtime': total_diff_runtime,
                'total_sum': total_sum
            })

        # 5. Sort users by the sum of total_choice_time + total_diff_runtime
        table_ranking.sort(key=lambda x: x['total_sum'])

        # 4. Calculate the 3 fastest times per control_pair_index
        fastest_times = []
        # For each control_pair_index, collect the total times (choice_time + selected_route_runtime - shortest_route_runtime)
        for control_pair_index in range(ncP_max):
            times_for_control = []

            for user_data in all_user_data:
                for control in user_data['controls']:
                    if control['index'] == control_pair_index:
                        total_time = (control['choice_time'] +
                                      (control['selected_route_runtime'] - control['shortest_route_runtime']))
                        times_for_control.append(total_time)

            # Sort the times for the current control_pair_index and take the 3 lowest
            times_for_control.sort()

            # Take the 3 lowest times or fewer if there aren't enough
            fastest_times_for_index = times_for_control[:3]
            average_fastest_time = sum(fastest_times_for_index) / len(fastest_times_for_index) if fastest_times_for_index else 0
            fastest_times.append({
                'ncP': control_pair_index,
                'average_fastest_time': round(average_fastest_time, 2)
            })

        # 6. Prepare the response
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
        # If a user_id is provided, check if the logged-in user is an admin
        if not user.is_staff:  # Only allow admins to view stats for other users
            return JsonResponse({"error": "Permission denied."}, status=403)
        
        # Get the user object for the specified user_id
        target_user = get_object_or_404(User, id=user_id)

    # Query the target user's results
    results_user = UserResult.objects.filter(user_id=target_user.id)
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
    results_global = UserResult.objects.filter()
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
