from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('project', '0005_label_color'),
    ]

    operations = [
        migrations.AddField(
            model_name='filesnapshot',
            name='name',
            field=models.CharField(blank=True, max_length=255),
        ),
        migrations.AddField(
            model_name='filesnapshot',
            name='author',
            field=models.CharField(blank=True, max_length=255),
        ),
        migrations.AddField(
            model_name='filesnapshot',
            name='label',
            field=models.ForeignKey(
                blank=True, null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='project.label',
            ),
        ),
    ]
