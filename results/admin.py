from django.contrib import admin
from .models import Choice
from account.models import Profile


@admin.register(Choice)
class ChoiceAdmin(admin.ModelAdmin):
    list_display = ('user', 'get_file', 'control_pair', 'choice_time', 'competition', 'timestamp')
    list_filter = ('competition', 'control_pair__file__team', 'timestamp')
    search_fields = ('user__username', 'control_pair__file__name')
    readonly_fields = ('timestamp',)

    def get_file(self, obj):
        return obj.control_pair.file.name
    get_file.short_description = 'File'
    get_file.admin_order_field = 'control_pair__file__name'

    def get_queryset(self, request):
        qs = super().get_queryset(request).select_related(
            'user', 'control_pair__file__team', 'selected_route'
        )
        if request.user.is_superuser:
            return qs
        try:
            active_team = request.user.profile.active_team
            return qs.filter(control_pair__file__team=active_team)
        except Profile.DoesNotExist:
            return qs.none()

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser