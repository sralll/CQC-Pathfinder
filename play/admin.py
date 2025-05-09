from django.contrib import admin
from .models import UserResult

@admin.register(UserResult)
class UserResultAdmin(admin.ModelAdmin):
    list_display = ('user', 'filename', 'control_pair_index', 'choice_time', 'selected_route_runtime', 'shortest_route_runtime','timestamp')
    list_filter = ('filename', 'user')  # <- This adds filtering options in admin
    search_fields = ('filename', 'user__username')