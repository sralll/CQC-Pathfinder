from django.contrib import admin
from .models import File, ControlPair, Route, Label, FileSnapshot, EditorSettings
from django.db.models import Count
from account.models import Profile


class ControlPairInline(admin.TabularInline):
    model = ControlPair
    extra = 0
    readonly_fields = ('order', 'complex')
    can_delete = False
    show_change_link = True

    def has_add_permission(self, request, obj=None):
        return False


class RouteInline(admin.TabularInline):
    model = Route
    extra = 0
    readonly_fields = ('order', 'length', 'run_time', 'elevation')
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False


@admin.register(File)
class FileAdmin(admin.ModelAdmin):
    list_display = ("name", "published", "deleted", "get_ncP", "author", "team", "label", "last_edited", "has_mask")
    search_fields = ("name", "author")
    list_filter = ("published", "deleted", "team", "label")
    inlines = [ControlPairInline]
    date_hierarchy = 'last_edited'

    def get_queryset(self, request):
        qs = super().get_queryset(request).annotate(ncP_count=Count('control_pairs'))
        if request.user.is_superuser:
            return qs
        try:
            active_team = request.user.profile.active_team
            return qs.filter(team=active_team)
        except Profile.DoesNotExist:
            return qs.none()

    def get_ncP(self, obj):
        return obj.ncP_count
    get_ncP.short_description = 'Control Pairs'
    get_ncP.admin_order_field = 'ncP_count'

    def has_add_permission(self, request):
        return request.user.is_superuser
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser


@admin.register(ControlPair)
class ControlPairAdmin(admin.ModelAdmin):
    list_display = ('file', 'order', 'complex', 'get_route_count')
    list_filter = ('complex', 'file__team')
    search_fields = ('file__name',)
    inlines = [RouteInline]

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('file', 'file__team').annotate(
            n_routes=Count('routes')
        )

    def get_route_count(self, obj):
        return obj.n_routes
    get_route_count.short_description = 'Routes'
    get_route_count.admin_order_field = 'n_routes'

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser


@admin.register(Route)
class RouteAdmin(admin.ModelAdmin):
    list_display = ('control_pair', 'order', 'length', 'run_time', 'elevation')
    list_filter = ('control_pair__file__team',)
    search_fields = ('control_pair__file__name',)

    def get_queryset(self, request):
        return super().get_queryset(request).select_related('control_pair__file', 'control_pair__file__team')

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser


@admin.register(FileSnapshot)
class FileSnapshotAdmin(admin.ModelAdmin):
    list_display  = ("file", "trigger", "n_control_pairs", "n_routes", "created_at", "created_by")
    list_filter   = ("trigger",)
    search_fields = ("file__name", "trigger", "created_by__username")
    readonly_fields = (
        "file", "created_at", "created_by",
        "trigger", "scale", "map_file", "has_mask",
        "blocked_terrain", "control_pairs",
        "n_control_pairs", "n_routes",
    )
    ordering = ("-created_at",)
    date_hierarchy = 'created_at'

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser


@admin.register(Label)
class LabelAdmin(admin.ModelAdmin):
    list_display = ('id', 'name', 'team', 'color')
    search_fields = ('name', 'team__name')
    list_filter = ('team',)
    ordering = ('team', 'name')


@admin.register(EditorSettings)
class EditorSettingsAdmin(admin.ModelAdmin):
    list_display = ('profile', 'auto_pathfind', 'auto_jump', 'autosave')
    search_fields = ('profile__user__username',)
    list_filter = ('auto_pathfind', 'auto_jump', 'autosave')
