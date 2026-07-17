from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('project', '0006_file_level_passages_filesnapshot_level_passages'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='editorsettings',
            name='autosave',
        ),
    ]
