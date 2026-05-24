from django.contrib import admin
from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import render, redirect
from django.urls import path
from .models import File, ControlPair
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
    list_display = ("name", "published", "get_ncP", "author", "team", "label", "last_edited")
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