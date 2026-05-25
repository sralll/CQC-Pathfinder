from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('project', '0002_migrate_data_from_publishedfile'),
    ]

    operations = [
        migrations.AlterField(
            model_name='file',
            name='last_edited',
            field=models.DateTimeField(auto_now=True),
        ),
    ]