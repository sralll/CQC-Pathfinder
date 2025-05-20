from django.contrib import admin
from .models import UserResult
from django.http import HttpResponse
import csv

@admin.register(UserResult)
class UserResultAdmin(admin.ModelAdmin):
    list_display = ('user', 'filename', 'control_pair_index', 'choice_time', 'selected_route_runtime', 'shortest_route_runtime','timestamp')
    list_filter = ('filename', 'user')  # <- This adds filtering options in admin
    search_fields = ('filename', 'user__username')
    actions = [download_userresults_csv]

@admin.action(description='Download selected results as CSV')
def download_userresults_csv(modeladmin, request, queryset):
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = 'attachment; filename=userresults.csv'
    
    writer = csv.writer(response)
    # Write header
    writer.writerow([field.name for field in UserResult._meta.fields])
    
    # Write data rows
    for obj in queryset:
        writer.writerow([getattr(obj, field.name) for field in UserResult._meta.fields])
    
    return response