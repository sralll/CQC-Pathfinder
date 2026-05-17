import os
import mimetypes
from django.contrib import admin
from django.contrib.admin.views.decorators import staff_member_required
from django.shortcuts import render, redirect
from django.http import FileResponse, HttpResponseNotFound
from django.contrib import messages
from django.conf import settings
from django.urls import path
from .models import publishedFile
from accounts.models import UserProfile


@admin.register(publishedFile)
class PublishedFileAdmin(admin.ModelAdmin):
    list_display = ("filename", "unique_filename", "published", "ncP", "author", "kader", "last_edited")
    search_fields = ("filename", "author__username")

    def has_add_permission(self, request):
        return request.user.is_superuser

    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser

    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            user_kader = request.user.userprofile.kader
            return qs.filter(kader=user_kader)
        except UserProfile.DoesNotExist:
            return qs.none()


# --- Media file admin views ---

def _human_size(size_bytes):
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024:
            return f'{size_bytes:.1f} {unit}'
        size_bytes /= 1024
    return f'{size_bytes:.1f} TB'


class MediaAdminSite(admin.AdminSite):
    """Extend the default admin site with custom media file URLs."""

    def get_urls(self):
        urls = super().get_urls()
        custom_urls = [
            path('media-files/', self.admin_view(media_files_view), name='media_files'),
            path('media-files/download/<str:filename>/', self.admin_view(media_file_download), name='media_file_download'),
            path('media-files/delete/<str:filename>/', self.admin_view(media_file_delete), name='media_file_delete'),
        ]
        return custom_urls + urls