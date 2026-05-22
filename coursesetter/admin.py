from django.contrib import admin
from .models import publishedFile
from accounts.models import UserProfile

@admin.register(publishedFile)
class PublishedFileAdmin(admin.ModelAdmin):
    list_display = ("filename", "unique_filename", "published", "ncP", "author", "kader", "last_edited")
    search_fields = ("filename", "author__username")

    # Only superusers can manually add published files
    def has_add_permission(self, request):
        return request.user.is_superuser
    
    # Only superusers can change published files
    def has_change_permission(self, request, obj=None):
        return request.user.is_superuser
    
    # Optional: only superusers can delete
    def has_delete_permission(self, request, obj=None):
        return request.user.is_superuser
    
    # Filter the displayed entries based on the user's kader
    def get_queryset(self, request):
        qs = super().get_queryset(request)
        if request.user.is_superuser:
            return qs
        try:
            user_kader = request.user.userprofile.kader
            return qs.filter(kader=user_kader)
        except UserProfile.DoesNotExist:
            return qs.none()