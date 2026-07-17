from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('account', '0002_delete_feedback'),
    ]

    operations = [
        migrations.DeleteModel(
            name='Device',
        ),
    ]
