from django.contrib import admin
from django.db.models import Q
from .models import Choice, InfiniteChoice, ReportedInfinity
from account.models import Profile
from account.admin_access import StaffHiddenAdmin


@admin.register(Choice)
class ChoiceAdmin(admin.ModelAdmin):
    list_display = ('user', 'team', 'get_file', 'control_pair', 'choice_time', 'penalty', 'competition', 'timestamp')
    list_filter = ('competition', 'team', 'timestamp')
    search_fields = ('user__username', 'control_pair__file__name')
    readonly_fields = ('timestamp',)
    date_hierarchy = 'timestamp'

    def get_file(self, obj):
        return obj.control_pair.file.name if obj.control_pair else '—'
    get_file.short_description = 'File'
    get_file.admin_order_field = 'control_pair__file__name'

    def get_queryset(self, request):
        qs = super().get_queryset(request).select_related(
            'user', 'team', 'control_pair__file__team', 'selected_route'
        )
        if request.user.is_superuser:
            return qs
        try:
            active_team = request.user.profile.active_team
            return qs.filter(Q(team=active_team) | Q(team__isnull=True, control_pair__file__team=active_team))
        except Profile.DoesNotExist:
            return qs.none()

    # Staff: view + delete, scoped to their active_team (get_queryset above).
    # Add/change stay off for everyone — Choice rows are gameplay data and
    # must not be hand-authored.
    def has_module_permission(self, request):
        return True
    def has_view_permission(self, request, obj=None):
        return True
    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return True


@admin.register(InfiniteChoice)
class InfiniteChoiceAdmin(StaffHiddenAdmin, admin.ModelAdmin):
    list_display = ('user', 'correct', 'choice_time', 'shorter_time', 'longer_time', 'timestamp')
    list_filter = ('correct', 'timestamp')
    search_fields = ('user__username',)
    readonly_fields = ('timestamp',)
    date_hierarchy = 'timestamp'

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser


@admin.register(ReportedInfinity)
class ReportedInfinityAdmin(StaffHiddenAdmin, admin.ModelAdmin):
    list_display = ('user', 'team', 'seed', 'pair_index', 'start_x', 'start_y', 'goal_x', 'goal_y', 'timestamp')
    list_filter = ('team', 'timestamp')
    search_fields = ('user__username', '=seed')
    readonly_fields = (
        'timestamp',
        'user',
        'team',
        'seed',
        'pair_index',
        'start_x',
        'start_y',
        'goal_x',
        'goal_y',
        'map_metres_per_unit',
        'settings',
        'route_indexes',
        'routes',
        'skipped_barriers',
        'route_result',
        'client_state',
        'user_agent',
    )
    date_hierarchy = 'timestamp'

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser
