# Generated by Django 5.2 on 2025-05-07 14:31

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("coursesetter", "0001_initial"),
    ]

    operations = [
        migrations.AlterField(
            model_name="clickresult",
            name="game",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE, to="coursesetter.gameround"
            ),
        ),
    ]
