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