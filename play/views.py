from django.shortcuts import render
import json
from django.conf import settings
from django.http import JsonResponse, HttpResponseNotFound
from django.views.decorators.http import require_GET
from django.contrib.auth.decorators import login_required
from .models import UserResult
from coursesetter.models import publishedFile
from accounts.models import UserProfile, DeviceCounter
from django.db.models import F

@login_required
def index(request):
    return render(request, 'play.html')

@require_GET
@login_required
def get_files(request):
    user = request.user
    metadata = []

    try:
        # Try to get user's kader
        try:
            user_kader = user.userprofile.kader
        except UserProfile.DoesNotExist:
            user_kader = None

        # Only load published files in the same kader
        files = publishedFile.objects.filter(published=True, kader=user_kader)

        for pub in files:
            filename = pub.filename
            cp_count = pub.ncP or 0
            file_base = filename.replace('.json', '')

            # Count how many control pairs the user has already entered
            existing_entries = UserResult.objects.filter(
                user=user,
                filename=file_base
            ).values_list('control_pair_index', flat=True)

            metadata.append({
                'filename': filename,
                'modified': pub.last_edited.isoformat() if pub.last_edited else '',
                'cPCount': cp_count,
                'userEntryCount': existing_entries.count(),
                'published': True,
            })

        return JsonResponse(metadata, safe=False)

    except Exception as e:
        return JsonResponse({'error': f'Error in get_files(): {str(e)}'}, status=500)


@login_required
def load_file(request, filename):
    try:
        user_agent = request.META.get('HTTP_USER_AGENT', '').lower()
        is_mobile = any(m in user_agent for m in ['iphone', 'android', 'ipad', 'mobile'])

        if not request.user.groups.filter(name='Trainer').exists(): #filter out trainers, always desktop
            # Increment counters
            counter, _ = DeviceCounter.objects.get_or_create(pk=1)
            if is_mobile:
                counter.mobile_count = F('mobile_count') + 1
            else:
                counter.desktop_count = F('desktop_count') + 1
            counter.save()

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

@login_required
def submit_result(request):
    if request.method != 'POST':
        return JsonResponse({'error': 'Invalid request'}, status=400)

    data = json.loads(request.body)

    exists = UserResult.objects.filter(
        user=request.user,
        filename=data['filename'],
        control_pair_index=data['control_pair_index']
    ).exists()

    if exists:
        return JsonResponse(
            {'status': 'duplicate', 'message': 'Result already exists'},
            status=200
        )

    # ✅ Get user's kader safely
    kader = (
        request.user.userprofile.kader
        if hasattr(request.user, "userprofile")
        else None
    )

    result = UserResult.objects.create(
        user=request.user,
        filename=data['filename'],
        control_pair_index=data['control_pair_index'],
        choice_time=data['choice_time'],
        selected_route=data['selected_route'],
        selected_route_runtime=data['selected_route_runtime'],
        shortest_route_runtime=data['shortest_route_runtime'],
        competition=data['competition'],
        kader=kader,  # ✅ stored snapshot
    )

    return JsonResponse({'status': 'success', 'result_id': result.id})