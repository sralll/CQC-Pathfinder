from django.contrib import admin
from .models import publishedFile

@admin.register(publishedFile)
class publishedFileAdmin(admin.ModelAdmin):
    list_display = ('filename', 'published','ncP')  # Columns shown in the admin list
    list_editable = ('ncP',)
    search_fields = ('filename',)
