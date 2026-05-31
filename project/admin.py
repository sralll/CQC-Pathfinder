from django.contrib import admin
from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import render, redirect
from django.urls import path
from .models import File, ControlPair, Label, FileSnapshot
from django.db.models import Count
from account.models import Profile

class ControlPairInline(admin.TabularInline):
    model = ControlPair
    extra = 0
    readonly_fields = ('order', 'complex')
    can_delete = False

    def has_add_permission(self, request, obj=None):
        return False

@admin.register(File)
class FileAdmin(admin.ModelAdmin):
    list_display = ("name", "published", "get_ncP", "author", "team", "label", "last_edited", "has_mask")
    search_fields = ("name", "author")
    list_filter = ("published", "team", "label")
    inlines = [ControlPairInline]

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

    def has_add_permission(self, request):
        return False
    def has_change_permission(self, request, obj=None):
        return False
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser


@admin.register(Label)
class LabelAdmin(admin.ModelAdmin):
    list_display = (
        'id',
        'name',
        'team',
    )
    search_fields = (
        'name',
        'team__name',
    )
    list_filter = (
        'team',
    )
    ordering = (
        'team',
        'name',
    )