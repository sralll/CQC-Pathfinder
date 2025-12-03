from django.db import migrations, models
from django.utils.text import slugify

def generate_unique_filenames(apps, schema_editor):
    PublishedFile = apps.get_model('coursesetter', 'publishedFile')
    for obj in PublishedFile.objects.all():
        base_slug = slugify(obj.filename.replace('.json', ''))
        kader_name = getattr(obj.kader, 'name', 'unknown')
        # Add the ID to ensure uniqueness
        unique_name = f"{base_slug}_{kader_name}_{obj.id}"
        if not unique_name.endswith('.json'):
            unique_name += '.json'
        obj.unique_filename = unique_name
        obj.save(update_fields=['unique_filename'])

class Migration(migrations.Migration):

    dependencies = [
        ('coursesetter', '0008_publishedfile_kader'),
    ]

    operations = [
        migrations.AddField(
            model_name='publishedfile',
            name='unique_filename',
            field=models.CharField(max_length=255, unique=True, null=True, blank=True),
        ),
        migrations.RunPython(generate_unique_filenames),
        migrations.AlterField(
            model_name='publishedfile',
            name='unique_filename',
            field=models.CharField(max_length=255, unique=True),
        ),
    ]