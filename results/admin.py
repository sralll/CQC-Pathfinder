import csv

from django.contrib import admin
from django.http import HttpResponse
from django.db.models import Q
from .models import Choice, InfiniteChoice, ReportedInfinity
from account.models import Profile
from account.admin_access import StaffHiddenAdmin


def _csv_response(filename, rows, headers):
    response = HttpResponse(content_type='text/csv')
    response['Content-Disposition'] = f'attachment; filename="{filename}"'
    writer = csv.writer(response)
    writer.writerow(headers)
    writer.writerows(rows)
    return response


def _format_timestamp(value):
    return value.isoformat() if value else ''


@admin.action(description='Download selected choices as CSV', permissions=['view'])
def export_choices_csv(modeladmin, request, queryset):
    queryset = queryset.select_related('user', 'team', 'control_pair__file', 'selected_route')
    headers = (
        'id',
        'user',
        'team',
        'file',
        'control_pair_id',
        'selected_route_id',
        'choice_time',
        'penalty',
        'competition',
        'timestamp',
    )
    rows = (
        (
            choice.id,
            choice.user.username if choice.user else '',
            choice.team.name if choice.team else '',
            choice.control_pair.file.name if choice.control_pair and choice.control_pair.file else '',
            choice.control_pair_id or '',
            choice.selected_route_id or '',
            choice.choice_time,
            choice.penalty,
            choice.competition,
            _format_timestamp(choice.timestamp),
        )
        for choice in queryset
    )
    return _csv_response('choices.csv', rows, headers)


@admin.action(description='Download selected infinite choices as CSV', permissions=['view'])
def export_infinite_choices_csv(modeladmin, request, queryset):
    queryset = queryset.select_related('user', 'team')
    headers = (
        'id',
        'user',
        'team',
        'correct',
        'choice_time',
        'shorter_time',
        'longer_time',
        'chosen_time',
        'pct_diff',
        'timestamp',
    )
    rows = (
        (
            choice.id,
            choice.user.username if choice.user else '',
            choice.team.name if choice.team else '',
            choice.correct,
            choice.choice_time,
            choice.shorter_time,
            choice.longer_time,
            choice.chosen_time,
            choice.pct_diff,
            _format_timestamp(choice.timestamp),
        )
        for choice in queryset
    )
    return _csv_response('infinite_choices.csv', rows, headers)


@admin.register(Choice)
class ChoiceAdmin(admin.ModelAdmin):
    list_display = ('user', 'team', 'get_file', 'control_pair', 'choice_time', 'penalty', 'competition', 'timestamp')
    list_filter = (('user', admin.RelatedOnlyFieldListFilter), 'competition', 'team', 'timestamp')
    search_fields = ('user__username', 'control_pair__file__name')
    readonly_fields = ('timestamp',)
    date_hierarchy = 'timestamp'
    actions = (export_choices_csv,)

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
class InfiniteChoiceAdmin(admin.ModelAdmin):
    list_display = ('user', 'team', 'correct', 'choice_time', 'shorter_time', 'longer_time', 'timestamp')
    list_filter = (('user', admin.RelatedOnlyFieldListFilter), 'team', 'correct', 'timestamp')
    search_fields = ('user__username',)
    readonly_fields = ('timestamp',)
    date_hierarchy = 'timestamp'
    actions = (export_infinite_choices_csv,)

    def get_queryset(self, request):
        qs = super().get_queryset(request).select_related('user', 'team')
        if request.user.is_superuser:
            return qs
        try:
            active_team = request.user.profile.active_team
            return qs.filter(team=active_team)
        except Profile.DoesNotExist:
            return qs.none()

    def has_module_permission(self, request):
        return True
    def has_view_permission(self, request, obj=None):
        return True
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
