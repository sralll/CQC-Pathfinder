from django.contrib import admin
from .models import publishedFile

@admin.register(publishedFile)
class publishedFileAdmin(admin.ModelAdmin):
    list_display = ('filename', 'published','ncP', 'author')  # Columns shown in the admin list
    list_editable = ('ncP','author')
    search_fields = ('filename','author')