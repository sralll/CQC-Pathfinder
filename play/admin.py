from django.contrib import admin
from .models import UserResult
from django.http import HttpResponse
import csv
from accounts.models import UserProfile
from django.contrib.auth.models import User
from django.contrib.admin import SimpleListFilter

@admin.action(description='Download selected results as CSV')
def download_userresults_csv(modeladmin, request, queryset):
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename=userresults.csv'
    
    writer = csv.writer(response)
    writer.writerow([field.name for field in UserResult._meta.fields])
    
    for obj in queryset:
        writer.writerow([getattr(obj, field.name) for field in UserResult._meta.fields])
    
    return response

# Custom filter for Users within the same kader
class UserKaderFilter(SimpleListFilter):
    title = 'User'
    parameter_name = 'user'

    def lookups(self, request, model_admin):
        if request.user.is_superuser:
            users = User.objects.all()
        else:
            try:
                user_kader = request.user.userprofile.kader
                users = User.objects.filter(userprofile__kader=user_kader)
            except UserProfile.DoesNotExist:
                users = User.objects.none()
        return [(u.id, u.username) for u in users]

    def queryset(self, request, queryset):
        if self.value():
            return queryset.filter(user_id=self.value())
        return queryset

# Custom filter for filenames within the same kader
class FilenameKaderFilter(SimpleListFilter):
    title = 'Filename'
    parameter_name = 'filename'

    def lookups(self, request, model_admin):
        qs = model_admin.get_queryset(request)
        if not request.user.is_superuser:
            try:
                user_kader = request.user.userprofile.kader
                qs = qs.filter(kader=user_kader)
            except UserProfile.DoesNotExist:
                qs = qs.none()
        filenames = qs.values_list('filename', flat=True).distinct()
        return [(f, f) for f in filenames]

    def queryset(self, request, queryset):
        if self.value():
            return queryset.filter(filename=self.value())
        return queryset

@admin.register(UserResult)
class UserResultAdmin(admin.ModelAdmin):
    list_display = (
        'user', 'filename', 'control_pair_index', 'choice_time',
        'selected_route', 'selected_route_runtime', 'shortest_route_runtime', 'longest_route_runtime',
        'competition', 'kader', 'timestamp'
    )
    list_filter = (FilenameKaderFilter, UserKaderFilter)
    search_fields = ('filename', 'user__username')
    actions = [download_userresults_csv]

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            user_kader = request.user.userprofile.kader
            return qs.filter(kader=user_kader)
        except UserProfile.DoesNotExist:
            return qs.none()
    
    # Prevent adding new UserResult in the admin
    def has_add_permission(self, request):
        return False
    
    # Only superusers can change published files
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser