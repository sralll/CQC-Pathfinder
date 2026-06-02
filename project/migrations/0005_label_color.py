from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('project', '0004_file_lock'),
    ]

    operations = [
        migrations.AddField(
            model_name='label',
            name='color',
            field=models.CharField(default='#5b8db8', max_length=7),
        ),
    ]
