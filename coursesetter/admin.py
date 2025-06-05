from django.contrib import admin
from .models import publishedFile

@admin.register(publishedFile)
class publishedFileAdmin(admin.ModelAdmin):
    list_display = ('filename', 'published')  # Columns shown in the admin list
    search_fields = ('filename',)