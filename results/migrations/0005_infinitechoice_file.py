from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('project', '0006_file_level_passages_filesnapshot_level_passages'),
        ('results', '0004_reported_infinity'),
    ]

    operations = [
        migrations.AddField(
            model_name='infinitechoice',
            name='file',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='infinite_choices',
                to='project.file',
            ),
        ),
        migrations.AddIndex(
            model_name='infinitechoice',
            index=models.Index(
                fields=['user', 'file'],
                name='infchoice_user_file_idx',
            ),
        ),
    ]
